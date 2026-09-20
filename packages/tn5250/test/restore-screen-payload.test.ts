import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadScreenResponse, buildSaveScreenResponse } from "../src/protocol/save-screen.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { COMMAND, ESC, OPCODE } from "../src/protocol/constants.js";

/**
 * **ホストが RESTORE SCREEN で返してくる「こちらの積荷」を、次のコマンドとして適用しない。**
 *
 * SAVE SCREEN の応答はホストにとって不透明な保管物で、RESTORE でそのまま返ってくる。
 * こちらの積荷は `ESC 0x11`（WTD）で始まる平文のデータストリームなので、読み飛ばさないと
 * **自分が送った WTD を適用して打鍵と MDT を潰す**（`20260920-restore-screen-parity` research F5・F10）。
 *
 * **「レコードの残りを捨てる」ではなく「送った長さぶん読み飛ばす」**——実機では
 * 積荷の後ろに READ MDT が同じレコードで続くことがある（同 research F9b・F16。QSH の出口で 2 回再現）。
 */
const codec = codecForCcsid(37);

/** GDS ヘッダ（10 バイト）と先頭の `ESC 0x12` を外して、積荷そのものを取り出す */
function payloadOf(record: Uint8Array): Uint8Array {
  expect(record[10]).toBe(ESC);
  expect(record[11]).toBe(COMMAND.RESTORE_SCREEN);
  return record.slice(12);
}

/** 画面に "AB" を書いて SAVE SCREEN を受けたところまで進めた状態を作る */
function savedScreen(): { buf: ScreenBuffer; payload: Uint8Array } {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 1, 0xc1, 0xc2]),
    buf,
    codec,
    () => {}
  );
  // ホストの SAVE SCREEN（退避）→ セッションが応答を組み立てて積荷を預ける、までを再現する
  applyDataStream(Uint8Array.from([ESC, COMMAND.SAVE_SCREEN]), buf, codec, () => {});
  const res = buildSaveScreenResponse(buf, codec, OPCODE.SAVE_SCREEN);
  buf.attachSaveContext(1, { payload: res.payload, readCommand: COMMAND.READ_MDT_FIELDS });
  return { buf, payload: payloadOf(res.record) };
}

/** 画面 1 行目の先頭 n 文字 */
const head = (buf: ScreenBuffer, n: number): string =>
  buf.snapshot().cells[0]!.slice(0, n).map((c) => c.char).join("");

describe("RESTORE SCREEN: ホストが返す自分の積荷を読み飛ばす", () => {
  it("積荷を次のコマンドとして適用しない（打鍵した文字が残る）", () => {
    const { buf, payload } = savedScreen();
    // 退避のあと、欄に打鍵した文字が入った状態にする（AID 送信でサーバー側バッファへ入る経路）
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 1, 0xd9, 0xd9]),
      buf,
      codec,
      () => {}
    );
    expect(head(buf, 2)).toBe("RR");

    const warns: string[] = [];
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN, ...payload]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    // 退避した時点の画面（"AB"）に戻る。積荷を適用していたら空白で潰れている
    expect(head(buf, 2)).toBe("AB");
    expect(warns).toEqual([]);
  });

  it("**積荷の後ろに続くホストのコマンドは失わない**（実機の QSH→F3 の形）", () => {
    const { buf, payload } = savedScreen();
    const result = applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.RESTORE_SCREEN, ...payload,
        // 実機はここに READ MDT を同じレコードで載せてくる
        // （`20260920-restore-screen-parity` research F9b。QSH→F3 で 2 回再現）
        ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
      ]),
      buf,
      codec,
      () => {}
    );
    expect(result.readRequested, "後続の READ MDT が生きている").toBe(true);
    expect(result.restoredCount).toBe(1);
  });

  it("積荷が一致しなければ 1 バイトも読み飛ばさない（警告して従来どおり解析する）", () => {
    const { buf, payload } = savedScreen();
    const warns: string[] = [];
    // 積荷の**最終バイト**を変えて「改変されて返ってきた」状況を作る
    // （先頭だけ見る実装だと素通りするので、末尾で全バイト照合が効いているかを見る）
    const tampered = Uint8Array.from(payload);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    const result = applyDataStream(
      Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN, ...tampered, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    expect(warns.some((w) => w.includes("payload mismatch")), "黙って捨てない").toBe(true);
    // 従来どおり積荷を解析するので、後続の READ にも到達する（＝退行していない）
    expect(result.readRequested).toBe(true);
  });

  it("積荷が無い（SAVE 応答を送っていない）ときは警告して従来どおり", () => {
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    applyDataStream(Uint8Array.from([ESC, COMMAND.SAVE_SCREEN]), buf, codec, () => {});
    const result = applyDataStream(
      Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    expect(result.readRequested).toBe(true);
    expect(result.restoredCount).toBe(1);
    // **黙らない**——本番でここに来るのは積荷を添え損ねた配線のずれのときだけ
    expect(warns.some((w) => w.includes("no payload recorded"))).toBe(true);
  });

  it("**1 レコードに SAVE が 2 回**でも、段ごとに積荷が添えられる", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 1, 0xc1, 0xc2]),
      buf,
      codec,
      () => {}
    );
    // SAVE SCREEN と SAVE PARTIAL が同じレコードに続く形
    const result = applyDataStream(
      Uint8Array.from([ESC, COMMAND.SAVE_SCREEN, ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0]),
      buf,
      codec,
      () => {}
    );
    expect(result.saveRequests.map((x) => x.depth), "段が 1・2 と並ぶ").toEqual([1, 2]);
    // セッション層と同じ順で応答を組み、段を指定して添える。
    // **段ごとに画面を変えてから組む**——同じバイト列だと「段を取り違えて添えた」が
    // 警告の有無でしか落ちず、内容で固定できない（`20260920-restore-screen-parity` review ラウンド 1）
    const payloads = result.saveRequests.map((req, i) => {
      applyDataStream(
        Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 10 + i, 0xe2, 0xf0 + i]),
        buf,
        codec,
        () => {}
      );
      const res = buildSaveScreenResponse(buf, codec, OPCODE.SAVE_SCREEN);
      buf.attachSaveContext(req.depth, { payload: res.payload, readCommand: COMMAND.READ_MDT_FIELDS });
      return res.payload;
    });
    expect(payloads[0], "段ごとに違う積荷になっている").not.toEqual(payloads[1]);

    const warns: string[] = [];
    // 2 段目 → 1 段目の順に戻す。どちらも積荷が添えられているので警告は出ない
    applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN, ...payloads[1]!]), buf, codec, (m) => warns.push(m));
    applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN, ...payloads[0]!]), buf, codec, (m) => warns.push(m));
    expect(warns, "先の段にも積荷が添えられている").toEqual([]);
    expect(head(buf, 2)).toBe("AB");
  });

  it("退避が空なら警告し、復元した回数に数えない", () => {
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    const result = applyDataStream(
      Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    expect(warns.some((w) => w.includes("empty save stack"))).toBe(true);
    expect(result.restoredCount, "段数がずれないように数えない").toBe(0);
  });
});

describe("退避・復元する状態（ACS `Save5250Net` に揃える）", () => {
  /** SOH で CA マスクを申告する WTD（本体 7 バイト: フラグ・予約・再順序・エラー行・マスク×3） */
  const sohWithMask = (m1: number, m2: number, m3: number): number[] => [
    ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
    0x01, 0x07, 0x00, 0x00, 0x00, 0x18, m1, m2, m3
  ];

  it("CA マスクが往復する（戻さないと F12 が欄データを送ってしまう）", () => {
    const buf = new ScreenBuffer();
    // F12 を「欄データを送らない」と申告（ヘッダ本体 5〜7 バイト目が F24〜F17 / F16〜F9 / F8〜F1）。
    // **`sendsDataForAid` はキー番号（1〜24）を取る**——AID コード（F12=0x3C）を渡すと
    // 範囲外で常に true になり、検査が空振りする
    applyDataStream(Uint8Array.from(sohWithMask(0x00, 0x08, 0x00)), buf, codec, () => {});
    const before = buf.sendsDataForAid(12);
    expect(before, "申告が効いている（＝この検査が空振りしていない）").toBe(false);

    applyDataStream(Uint8Array.from([ESC, COMMAND.SAVE_SCREEN]), buf, codec, () => {});
    // 退避したあと、別画面が申告を捨てる（CLEAR UNIT は `aidNoDataMask` を 0 に戻す）
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT]), buf, codec, () => {});
    expect(buf.sendsDataForAid(12), "申告が消えている").toBe(true);

    applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN]), buf, codec, () => {});
    expect(buf.sendsDataForAid(12), "復元で申告が戻る").toBe(before);
  });

  it("MDT が往復する（欄の定義ごと退避されている）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        0x11, 1, 1, 0x1d, 0x40, 0x00, 0x20, 0x00, 0x05 // SF: FFW=0x4000 属性=0x20 長さ=5
      ]),
      buf,
      codec,
      () => {}
    );
    const field = buf.snapshot().fields[0]!;
    buf.setFieldValue(buf.orderedFields()[0]!, "AB", false);
    expect(buf.snapshot().fields[0]!.mdt, "打鍵で MDT が立つ").toBe(true);

    applyDataStream(Uint8Array.from([ESC, COMMAND.SAVE_SCREEN]), buf, codec, () => {});
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT]), buf, codec, () => {});
    applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN]), buf, codec, () => {});

    const back = buf.snapshot().fields[0];
    expect(back?.mdt, "復元で MDT も戻る").toBe(true);
    expect(back?.index).toBe(field.index);
  });
});

describe("退避と復元の対応（積んだ項目は必ず戻る）", () => {
  /**
   * **型は「積んだが戻していない」を通してしまう**ので、往復で固定する。
   *
   * ⚠ **これは網羅ではない。** 見ているのは カーソル / 欄 / CA マスク / セル / メッセージ行番号 で、
   * `retainedEnds`・GUI の 4 種は別のテストが見ている
   * （`screen-buffer-attr-bounds.test.ts` / `save-restore-size.test.ts`）。
   * 「`savedStack` に足したら必ずここが落ちる」とは言えない
   * ——`msgLineRow` を足したときも落ちなかった（`20260920-restore-screen-parity` review ラウンド 3）。
   */
  it("退避した項目をすべて変えてから復元すると、元に戻る", () => {
    const buf = new ScreenBuffer();
    // SOH（フォーマットテーブルの開始＋ CA マスクの申告）→ SF、を 1 つの WTD で（実機と同じ順）
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        // SOH: メッセージ行 22（**既定の 24 ではない**）・F12 は CA
        0x01, 0x07, 0x00, 0x00, 0x00, 0x16, 0x00, 0x08, 0x00,
        0x11, 3, 5, 0x1d, 0x40, 0x00, 0x20, 0x00, 0x04 // SBA(3,5) ＋ SF
      ]),
      buf,
      codec,
      () => {}
    );
    // SOH のヘッダ本体 4 バイト目（0x18＝24）がメッセージ行。
    // **`msgLineRow` の往復はこれが唯一の検査**（リポジトリ全体で他に無い）
    const before = {
      cursor: buf.cursorAddr,
      fields: buf.snapshot().fields.length,
      sendsF12: buf.sendsDataForAid(12),
      cell: buf.snapshot().cells[2]!.map((c) => c.char).join(""),
      msgRow: buf.messageLineRow
    };

    applyDataStream(Uint8Array.from([ESC, COMMAND.SAVE_SCREEN]), buf, codec, () => {});
    // 退避したあと、全部を別物にする（CLEAR UNIT は CA マスクも 0 に戻す）
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.CLEAR_UNIT,
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        // **別の SOH でメッセージ行を 20 に変える**——`clearUnit()` は `msgLineRow` に触れないので、
        // ここで変えないと「復元を消しても緑」になる（`20260920-restore-screen-parity` review ラウンド 4 の must）
        0x01, 0x07, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00,
        0x11, 1, 1, 0xe9
      ]),
      buf,
      codec,
      () => {}
    );
    expect(buf.messageLineRow, "退避後に別の行へ変わっている").not.toBe(before.msgRow);
    expect(buf.snapshot().fields.length).not.toBe(before.fields);
    expect(buf.sendsDataForAid(12)).not.toBe(before.sendsF12);

    applyDataStream(Uint8Array.from([ESC, COMMAND.RESTORE_SCREEN]), buf, codec, () => {});
    expect(buf.cursorAddr, "カーソル").toBe(before.cursor);
    expect(buf.snapshot().fields.length, "欄").toBe(before.fields);
    expect(buf.sendsDataForAid(12), "CA マスク").toBe(before.sendsF12);
    expect(buf.snapshot().cells[2]!.map((c) => c.char).join(""), "セル").toBe(before.cell);
    expect(buf.messageLineRow, "メッセージ行番号").toBe(before.msgRow);
  });
});

describe("応答に載せる文字（ACS の `HostPlane` に合わせる）", () => {
  /** 応答の本体（GDS ヘッダ 10 バイトを外す）。READ SCREEN は前置なしの画面イメージ */
  const image = (buf: ScreenBuffer): Uint8Array =>
    buildReadScreenResponse(buf, codec, OPCODE.READ_SCREEN).slice(10);

  it("**打鍵した文字が空白に化けない**（この work が直した本体）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        0x11, 1, 1, 0x1d, 0x40, 0x00, 0x20, 0x00, 0x05 // SBA(1,1) ＋ SF（長さ 5）
      ]),
      buf,
      codec,
      () => {}
    );
    buf.setFieldValue(buf.orderedFields()[0]!, "AB", false);

    const body = image(buf);
    // 欄は属性桁(1,1)の次から。"AB" は EBCDIC で 0xC1 0xC2
    expect(body[1], "打鍵した A").toBe(0xc1);
    expect(body[2], "打鍵した B").toBe(0xc2);
    // ~~`rawByte ?? 0x40`~~ だったころは、どちらも 0x40（空白）になっていた
    // （`20260920-restore-screen-parity` research F10）
  });

  it("オーダー 0x1C / 0x1E は**受信した識別バイト**で返す（ACS の `HostPlane` と同じ）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 1, 0x1c, 0x1e]),
      buf,
      codec,
      () => {}
    );
    // 表示は "*" と ";"（`wtd-applier` の注記）だが、**送るのは元バイト**
    expect(buf.snapshot().cells[0]!.slice(0, 2).map((c) => c.char).join("")).toBe("*;");
    const body = image(buf);
    expect(body[0], "0x1C のまま").toBe(0x1c);
    expect(body[1], "0x1E のまま").toBe(0x1e);
  });

  it("ホストが「表せない」と言ってきた桁も、その元バイトで返す（**配線ごと固定する**）", () => {
    // `applyDataStream` を通す——直に `setUnmappable` を呼ぶと、この work が足した配線
    // （`wtd-applier` の `setUnmappable(addr++, UNMAPPABLE)`）を固定できない
    // （`20260920-restore-screen-parity` review ラウンド 4）。`UNMAPPABLE` は 0x1F
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 1, 1, 0x1f]),
      buf,
      codec,
      () => {}
    );
    expect(image(buf)[0], "受信した 0x1F のまま").toBe(0x1f);
  });

  it("**制御文字は属性帯に化けさせず空白に倒す**（`b < 0x40`）", () => {
    // `validateFieldContent` は制御文字を弾かないので、WS/MCP/マクロ経由で書けてしまう。
    // そのまま載ると、画面イメージ応答では**属性バイト**（`isAttribute` は 0x20–0x3F）、
    // SAVE 積荷では**別のオーダー列**に化ける（`20260920-restore-screen-parity` review ラウンド 3・4）。
    // 実測（CCSID 37/273/930/939/1399）で C0 制御は 11 件が属性帯へ落ちる。U+000A → 0x25 が代表
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        0x11, 1, 1, 0x1d, 0x40, 0x00, 0x20, 0x00, 0x05
      ]),
      buf,
      codec,
      () => {}
    );
    buf.setFieldValue(buf.orderedFields()[0]!, "\n", false);

    const body = image(buf);
    expect(body[1], "属性帯（0x20–0x3F）に化けていない").toBe(0x40);

    // SAVE 積荷（WTD ストリーム）でも同じ
    const payload = buildSaveScreenResponse(buf, codec, OPCODE.SAVE_SCREEN).payload;
    expect([...payload], "積荷にも属性帯のバイトを載せない").not.toContain(0x25);
  });

  it("未書き込み桁は `0x00`（ACS は `HostPlane` をそのまま返す）", () => {
    const buf = new ScreenBuffer();
    const body = image(buf);
    expect(body[0]).toBe(0x00);
    expect(body.length, "画面サイズちょうど").toBe(24 * 80);
  });

  it("DBCS は**受信したバイト対**をそのまま返す（符号化し直さない）", () => {
    const buf = new ScreenBuffer();
    const dbcsCodec = codecForCcsid(930);
    buf.setDbcs(0, "亜", 0x30, 0x21);
    const body = buildReadScreenResponse(buf, dbcsCodec, OPCODE.READ_SCREEN).slice(10);
    expect([body[0], body[1]], "lead/tail の生バイト").toEqual([0x30, 0x21]);
  });

  it("lead の対が SBCS で上書きされていたら、生バイト対として送らない", () => {
    const buf = new ScreenBuffer();
    const dbcsCodec = codecForCcsid(930);
    buf.setDbcs(0, "亜", 0x30, 0x21);
    buf.setChar(1, "A", 0xc1); // tail を SBCS で潰す
    const body = buildReadScreenResponse(buf, dbcsCodec, OPCODE.READ_SCREEN).slice(10);
    // 生バイト対の経路へ落ちない（`charKind === "dbcs-tail"` を確かめているため）
    expect([body[0], body[1]]).not.toEqual([0x30, 0x21]);
  });
});
