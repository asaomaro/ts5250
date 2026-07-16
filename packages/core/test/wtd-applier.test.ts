import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
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

  it("未知コマンドは警告してレコードの残りを打ち切る（例外にしない）", () => {
    const { warns, buf } = apply([
      ESC, 0x99, 0x01, 0x02,
      ESC, COMMAND.CLEAR_UNIT // 到達しない
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("0x99");
    expect(buf.snapshot("t", false)).toBeTruthy();
  });

  it("未知オーダーは警告して残りを打ち切る", () => {
    const { warns } = apply([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      0x1c, // DUP 等・01 では未対応オーダー
      ...e("X")
    ]);
    expect(warns).toHaveLength(1);
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
