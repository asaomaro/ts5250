import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, FFW } from "../src/protocol/constants.js";
import { firstRecordFromFixture } from "./gds.test.js";

const codec = codecForCcsid(37);

function rowText(buf: ScreenBuffer, row: number): string {
  const snap = buf.snapshot("t", false);
  return (snap.cells[row - 1] ?? []).map((c) => c.char).join("").replace(/ +$/, "");
}

/** EBCDIC 文字列リテラル（テスト用） */
function e(text: string): number[] {
  return [...codec.encode(text).bytes];
}

describe("applyDataStream — PUB400 実 trace", () => {
  it("サインオン画面全体を適用できる", () => {
    const rec = firstRecordFromFixture("pub400-signon.jsonl");
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    const result = applyDataStream(parseRecord(rec).data, buf, codec, (w) => warns.push(w));

    expect(warns).toEqual([]); // 未知オーダーなしで完走
    expect(result.unlockKeyboard).toBe(true);
    expect(result.readRequested).toBe(true);

    expect(rowText(buf, 1)).toContain("Welcome to PUB400.COM");
    expect(rowText(buf, 5)).toContain("Your user name:");
    expect(rowText(buf, 6)).toContain("Password (max. 128):");

    const snap = buf.snapshot("t", false);
    expect(snap.fields).toHaveLength(2);
    expect(snap.fields[0]).toMatchObject({ row: 5, col: 25, length: 10, hidden: false });
    expect(snap.fields[1]).toMatchObject({ row: 6, col: 25, length: 128, hidden: true, value: "" });
  });
});

describe("applyDataStream — 合成データ", () => {
  function apply(bytes: number[], buf = new ScreenBuffer()) {
    const warns: string[] = [];
    const result = applyDataStream(Uint8Array.from(bytes), buf, codec, (w) => warns.push(w));
    return { buf, result, warns };
  }

  it("CLEAR_UNIT + WTD の文字・属性書き込み", () => {
    const { buf } = apply([
      ESC, COMMAND.CLEAR_UNIT,
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 2, 5,
      0x22, // white 属性
      ...e("HI")
    ]);
    expect(rowText(buf, 2)).toBe("     HI"); // 属性桁(2,5)は空白、(2,6)から HI
    const snap = buf.snapshot("t", false);
    expect(snap.cells[1]?.[5]).toMatchObject({ char: "H", color: "white" });
  });

  it("RA が指定アドレスまで文字を繰り返す", () => {
    const { buf } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 1,
      ORDER.RA, 1, 5, ...e("=")
    ]);
    expect(rowText(buf, 1)).toBe("=====");
  });

  it("EA が length＋属性バイトを消費し、target を含めて消去する", () => {
    const first = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 1, ...e("ABCDE")
    ]);
    // EA 行=1 桁=4 length=2（属性 1 バイト続くが length=2 なので属性は 1 バイト）
    // ここでは length=3（属性タイプ 2 バイト）で、パーサがそれらを正しく読み飛ばすことを検証
    const { buf, warns } = apply(
      [
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 1, 2,
        ORDER.EA, 1, 4, 0x03, 0xff, 0xff, // length=3, 属性タイプ×2
        ORDER.SBA, 1, 5, ...e("Z") // 属性を読み飛ばせていれば SBA として正しく解釈される
      ],
      first.buf
    );
    expect(warns).toEqual([]);
    // (1,2)〜(1,4) を消去（B C D 消去）、A 残る、E は (1,5) だが Z で上書き
    expect(rowText(buf, 1)).toBe("A   Z");
  });

  it("EA の不正な length は警告してレコードを打ち切る", () => {
    const { warns } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 1,
      ORDER.EA, 1, 4, 0x09 // length=9 は範囲外(2-5)
    ]);
    expect(warns[0]).toContain("EA length");
  });

  it("SF がフィールドを登録し、後続データが初期値になる", () => {
    const ffw = FFW.ID_VALUE; // 入力可
    const { buf } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 10,
      ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff, 0x24, 0x00, 0x05, // attr=0x24(underline), len=5
      ...e("INI")
    ]);
    const snap = buf.snapshot("t", false);
    expect(snap.fields[0]).toMatchObject({ row: 3, col: 11, length: 5, value: "INI" });
    expect(snap.cells[2]?.[10]).toMatchObject({ char: "I", underline: true });
  });

  it("IC がカーソルを設定する", () => {
    const { buf } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.IC, 6, 53
    ]);
    expect(buf.snapshot("t", false).cursor).toEqual({ row: 6, col: 53 });
  });

  it("CC1=0x60 で全フィールドの MDT がリセットされる", () => {
    const setup = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 1,
      ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x03
    ]);
    setup.buf.setFieldValue(setup.buf.fieldByIndex(1), "AB");
    expect(setup.buf.mdtFields()).toHaveLength(1);
    apply([ESC, COMMAND.WRITE_TO_DISPLAY, 0x60, 0x00], setup.buf);
    expect(setup.buf.mdtFields()).toHaveLength(0);
  });

  it("READ_MDT_FIELDS で readRequested / unlock が立つ", () => {
    const { result } = apply([ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00]);
    expect(result.readRequested).toBe(true);
    expect(result.unlockKeyboard).toBe(true);
  });

  it("WRITE_ERROR_CODE が systemMessage に載る", () => {
    const { buf } = apply([ESC, COMMAND.WRITE_ERROR_CODE, ...e("CPF1120 - User not found")]);
    expect(buf.snapshot("t", false).systemMessage).toBe("CPF1120 - User not found");
  });

  /**
   * **WRITE_ERROR_CODE の DBCS（漢字）メッセージが文字化けしない。**
   *
   * 実機のトレースで、日本語のエラーメッセージ（"機能キーは使用できません。"）が
   * SO/SI で挟まれた DBCS として送られてきた。以前の実装は 1 バイトずつ decodeByte に
   * 通していたため、DBCS のペアがそれぞれ無関係な SBCS 文字に化けていた
   * （画面下部のエラー行が文字化けする不具合として利用者から報告された）。
   */
  it("WRITE_ERROR_CODE の DBCS メッセージが文字化けしない（実機トレース）", () => {
    const codec930 = codecForCcsid(930);
    const record = Uint8Array.from([
      0x00, 0x60, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, 0x04, 0x21, 0x22,
      0x0e, 0x45, 0x79, 0x47, 0x4f, 0x43, 0x87, 0x43, 0x58, 0x44, 0x9d, 0x48, 0xb6,
      0x45, 0xb6, 0x44, 0xcd, 0x44, 0x87, 0x44, 0xa4, 0x44, 0x8f, 0x44, 0xbd, 0x43,
      0x41, 0x0f, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      0x20, 0x04, 0x52, 0x00, 0x00
    ]);
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    applyDataStream(parseRecord(record).data, buf, codec930, (w) => warns.push(w));
    expect(warns).toEqual([]);
    expect(buf.snapshot("t", false).systemMessage).toBe("機能キーは使用できません。");
  });

  /**
   * **窓が開いている間のエラーは WRITE ERROR CODE TO WINDOW（0x22）で来る。**
   *
   * 実機の DDS 窓（TESTLIB/GRIDTST5・WINDOW(8 25 8 30)）で、CFxx を宣言して
   * いない記述にファンクション・キーを送ったときのレコードそのもの。未処理だと未知コマンド
   * として**レコードの残りを丸ごと捨て**、同居している READ MDT FIELDS（`04 52 00 00`）が
   * 消えてキーボードがロックしたまま＝「F3 を押すと応答なしでタイムアウト」になる。
   * 0x21 との差は先頭 2 バイト（0x1a=26・0x38=56 ＝窓内メッセージ行の開始桁・終了桁）だけ。
   */
  it("WRITE_ERROR_CODE_WINDOW でも読み取り要求が生き残る（実機トレース）", () => {
    const codec939 = codecForCcsid(939);
    const record = Uint8Array.from([
      0x00, 0x31, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03,
      0x04, 0x22, 0x1a, 0x38, 0x22,
      0x0e, 0x45, 0x79, 0x47, 0x4f, 0x43, 0x87, 0x43, 0x58, 0x44, 0x9d, 0x48, 0xb6,
      0x45, 0xb6, 0x44, 0xcd, 0x44, 0x87, 0x44, 0xa4, 0x44, 0x8f, 0x44, 0xbd, 0x43,
      0x41, 0x0f, 0x40, 0x40,
      0x04, 0x52, 0x00, 0x00
    ]);
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    const result = applyDataStream(parseRecord(record).data, buf, codec939, (w) => warns.push(w));
    expect(warns).toEqual([]);
    expect(buf.snapshot("t", false).systemMessage).toBe("機能キーは使用できません。");
    // ここが本題: 後半の READ MDT FIELDS まで届いてキーボードが解放される
    expect(result.readRequested).toBe(true);
    expect(result.unlockKeyboard).toBe(true);
  });

  it("未知コマンドは警告してレコードの残りを打ち切る（例外にしない）", () => {
    const { warns, buf } = apply([
      ESC, 0x99, 0x01, 0x02,
      ESC, COMMAND.CLEAR_UNIT // 到達しない
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("0x99");
    expect(buf.snapshot("t", false)).toBeTruthy();
  });

  /**
   * **未知オーダーは警告するが、レコード全体は打ち切らない（次の ESC まで読み飛ばす）。**
   *
   * 実機で正体不明のオーダー（0x1C 等）に当たった直後の WRITE（キーボード解放）・READ が
   * 丸ごと失われ、ホストは応答したつもりでもクライアントの鍵盤が開かず
   * 「応答待ちのまま固まる」不具合として利用者から報告された。ESC(0x04) は表示データにも
   * 他のオーダーにも現れないので、次の ESC まで読み飛ばして次のコマンドから復帰できる。
   */
  it("未知オーダーは警告するが次の ESC から復帰する（レコード全体は打ち切らない）", () => {
    const { warns, buf, result } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      0x16, // 0x15(WDSF)〜0x1D(SF) の間の未使用番地。まだ未対応のオーダー
      ...e("X"), // 読み飛ばされ、画面には出ない
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x08, // CC2 unlock
      ORDER.SBA, 1, 1, ...e("HELLO"),
      ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("0x16");
    expect(rowText(buf, 1)).toContain("HELLO"); // 未知オーダー後続のコマンドも適用される
    expect(result.unlockKeyboard).toBe(true); // キーボード解放が失われない
    expect(result.readRequested).toBe(true);
  });

  /**
   * **0x1C は "*" 1 文字を表示する（正体未確認・実機表示との突き合わせで確定）。**
   *
   * 実機の標準システム画面「スプール・ファイルの表示」（DSPSPLF 系）のトレースで観測。
   * 桁末尾で打ち切られた DBCS 見出しフィールドの直後・サブファイル明細データの直前に
   * 一度だけ現れ、以前はここで「未知オーダー」として警告されレコードの残りが失われて
   * いた（利用者の報告では、見出し以降のデータ行が丸ごと表示されない症状だった）。
   * 当初は 0 引数の読み飛ばし（no-op）として直したが、ACS の実際の表示（"仕*"）と
   * 突き合わせたところ "*" が 1 文字欠けていた（利用者のスクリーンショット比較で発覚）。
   * "*" は 1 桁占有するので、続く表示データは 1 桁分後ろにずれて正しい位置に来る。
   *
   * **rawByte は付けない。** 0x1C はオーダー自身の識別バイトであって受信した文字バイトでは
   * ないので、rawByte として持たせるとカタカナ表示モードが半角カナに再解釈して化ける。
   */
  it('0x1C は "*" 1 文字を表示し、後続の表示データを取りこぼさない', () => {
    const { warns, buf } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 1, ...e("A"),
      ORDER.UNKNOWN_1C,
      ...e("B")
    ]);
    expect(warns).toEqual([]);
    expect(rowText(buf, 1)).toContain("A*B");
    const cell = buf.snapshot("t", false).cells[0]?.[1];
    expect(cell?.rawByte).toBeUndefined(); // カタカナ表示モードで再解釈されない
  });

  it("CLEAR_UNIT_ALTERNATE は警告付きでクリアにフォールバックする", () => {
    const { warns } = apply([ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x00]);
    expect(warns[0]).toContain("ALTERNATE");
  });

  it("CLEAR_UNIT_ALTERNATE のパラメータを消費し後続 WTD を取りこぼさない（回帰・DBCS 端末の SEU）", () => {
    // ESC 20 00（CLEAR UNIT ALTERNATE + パラメータ）の後に ESC 11（WTD）が続く実機パターン。
    // 旧実装はパラメータ 0x00 を次コマンドの ESC と誤認し "expected ESC" で残りを破棄していた
    // ＝画面本体を取りこぼして何も表示されなかった。
    const { buf, warns } = apply([
      ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x00,
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 1, ...e("HELLO")
    ]);
    expect(warns.some((w) => /expected ESC/.test(w))).toBe(false); // フレーム同期がずれない
    expect(rowText(buf, 1)).toContain("HELLO"); // 後続 WTD が適用される（旧: 空）
  });
});

describe("applyDataStream — DBCS（SO/SI）", () => {
  it("SO/SI と DBCS 文字を桁位置を保って配置する", () => {
    const dbcsCodec = codecForCcsid(1399);
    // "A" + SO + 日本 + SI + "B" を WTD で書く
    const jp = [...dbcsCodec.encode("日本").bytes]; // SO xx xx xx xx SI
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 1, 1,
        ...codecForCcsid(1399).encode("A").bytes, // 'A'
        ...jp,
        ...codecForCcsid(1399).encode("B").bytes // 'B'
      ]),
      buf,
      dbcsCodec,
      (w) => warns.push(w)
    );
    expect(warns).toEqual([]);
    const snap = buf.snapshot("t", false);
    const row = snap.cells[0]!;
    // 桁: 1=A, 2=SO(空白), 3-4=日, 5-6=本, 7=SI(空白), 8=B
    expect(row[0]).toMatchObject({ char: "A", kind: "sbcs" });
    expect(row[1]).toMatchObject({ char: " ", kind: "so" });
    expect(row[2]).toMatchObject({ char: "日", kind: "dbcs-lead" });
    expect(row[3]).toMatchObject({ char: "", kind: "dbcs-tail" });
    expect(row[4]).toMatchObject({ char: "本", kind: "dbcs-lead" });
    expect(row[5]).toMatchObject({ char: "", kind: "dbcs-tail" });
    expect(row[6]).toMatchObject({ char: " ", kind: "si" });
    expect(row[7]).toMatchObject({ char: "B", kind: "sbcs" });
  });

  it("cells は DBCS 行でも全 80 桁を保持する（桁ズレなし）", () => {
    const dbcsCodec = codecForCcsid(1399);
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 1, 1,
        ...dbcsCodec.encode("日本語テスト").bytes
      ]),
      buf,
      dbcsCodec
    );
    const snap = buf.snapshot("t", false);
    expect(snap.cells[0]).toHaveLength(80);
    expect(snap.cells[1]).toHaveLength(80);
  });
});

/**
 * **表せない文字（0x1F）はオーダーではない。**
 *
 * 英語システム（PUB400）へカタカナのコードページ（CCSID 5026＝CP 290）で繋ぐと、
 * ヘルプ本文の英小文字がすべて 0x1F で届く（1076 バイトに 531 個。実測）。
 * 同じ画面を CCSID 37 / 5035 で採ると 0 個。
 *
 * オーダーとして扱うと解析がそこで崩れ、復帰の途中で SBA の行桁パラメータ
 * （`11 04 05`）の `0x04` を ESC と読み違え、**末尾の READ MDT FIELDS ごと捨てる**。
 * 読み取り要求が消えるので鍵盤が開かず「ホストからの応答待ち」で固まる（利用者報告）。
 */
describe("表せない文字（0x1F）", () => {
  /** `WTD` で "IBM i" 相当（小文字が 0x1F に置き換わった形）を書き、末尾に READ を置く */
  const record = () =>
    Uint8Array.from([
      0x04, 0x11, 0x00, 0x00, // ESC WTD CC1 CC2
      0x11, 0x01, 0x01, // SBA(1,1)
      0x20, // 属性
      0xc9, 0xc2, 0xd4, 0x40, 0x1f, // "IBM" + 空白 + 表せない 1 文字
      0x11, 0x04, 0x05, // SBA(4,5) — **行バイトが 0x04**（ESC と紛らわしい）
      0x20,
      0xc8, 0x1f, 0x1f, 0x1f, // "H" + 表せない 3 文字
      0x04, 0x52, 0x00, 0x00 // ESC READ MDT FIELDS
    ]);

  it("1 桁を占める空白として置き、解析を続ける", () => {
    const buf = new ScreenBuffer(24, 80);
    const result = applyDataStream(record(), buf, codec, () => {});
    // 属性が 1 桁、そのあと "IBM" と空白 2 つ（元の空白と表せない文字）
    expect(rowText(buf, 1).slice(1, 6)).toBe("IBM");
    void result;
  });

  it("**末尾の READ を捨てない**（捨てると鍵盤が開かず応答待ちで固まる）", () => {
    const buf = new ScreenBuffer(24, 80);
    const result = applyDataStream(record(), buf, codec, () => {});
    expect(result.readRequested).toBe(true);
    expect(result.unlockKeyboard).toBe(true);
  });

  /** 理由と直し方まで言う。黙って空白にすると「ヘルプが虫食い」としか見えない */
  it("何個あったかと、CCSID を変えれば直ることを 1 度だけ知らせる", () => {
    const buf = new ScreenBuffer(24, 80);
    const warnings: string[] = [];
    applyDataStream(record(), buf, codec, (w) => warnings.push(w));
    const hit = warnings.filter((w) => w.includes("表せない文字"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain("4 個");
    expect(hit[0]).toContain("CCSID");
  });

  /** 未知オーダーからの復帰も、**直後が既知コマンドの ESC** だけを信じる */
  it("未知オーダーの後、SBA のパラメータを ESC と読み違えない", () => {
    const buf = new ScreenBuffer(24, 80);
    const rec = Uint8Array.from([
      0x04, 0x11, 0x00, 0x00,
      0x1e, // 未知オーダー
      0x11, 0x04, 0x05, // SBA(4,5) — 0x04 が続く
      0x20, 0xc1,
      0x04, 0x52, 0x00, 0x00 // ESC READ MDT FIELDS
    ]);
    const result = applyDataStream(rec, buf, codec, () => {});
    expect(result.readRequested).toBe(true);
  });
});
