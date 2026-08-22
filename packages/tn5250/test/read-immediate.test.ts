import { describe, it, expect } from "vitest";
import { buildReadImmediateResponse } from "../src/protocol/read-response.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ORDER, OPCODE, FFW, COMMAND, ESC } from "../src/protocol/constants.js";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **READ IMMEDIATE（0x72）**。
 *
 * ホストが「利用者を待たずに、いま画面の欄を送れ」と言ってくるコマンド。
 * 通常の画面では届かない（20 画面 142 レコードの census でも 0 件）が、
 * **実機で裏を取ってある**——IBM 自身が発行する API（DSM の `QsnReadImm`）で出させ、
 * 往復が成立することを確かめた（`scripts/diag-read-immediate-osaka.mjs`）:
 *
 * ```
 * 受信  04 72                          送信  14 07 00 11 14 07 c3c1d3d3
 * ホスト側  QsnReadImm rc=21 bytesRead=21 fdbk_bytes=0
 * ```
 *
 * ## 原典（GNU tn5250 `session.c`）
 *
 * ```c
 * case CMD_READ_IMMEDIATE:
 *     if (tn5250_dbuffer_mdt(dbuffer)) {          // 画面単位の門番
 *         field = dbuffer->field_list;
 *         do { tn5250_session_send_field(...); field = field->next; }  // 欄ごとの MDT は見ない
 *         while (field != dbuffer->field_list);
 *     }
 *     break;
 * ```
 *
 * `tn5250_session_read_immediate` が `send_fields(This, 0)` を呼ぶので **AID は 0**。
 *
 * ## tn5250j との突き合わせ
 *
 * tn5250j は **`0x72` を扱わず**、`0x83`（READ MDT IMMEDIATE ALT）だけを実装している。
 * **矛盾ではなく別のコマンド**——名前どおり `0x83` は MDT の欄だけを送る。
 * **一致するのは**「`masterMDT` が門番」「待たずに即送信」「opcode は PUT_GET」の 3 点で、
 * ここで固定しているのはその 3 点。
 */

const codec = codecForCcsid(37);

/** 入力欄を 2 つ持つ画面 */
function makeBuffer(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(5, 24), 0x24);
  b.addField(b.addrOf(5, 25), 10, FFW.ID_VALUE, 0x24);
  b.setAttr(b.addrOf(6, 24), 0x27);
  b.addField(b.addrOf(6, 25), 8, FFW.ID_VALUE, 0x27);
  return b;
}

const dataOf = (record: Uint8Array): number[] => [...parseRecord(record).data];

describe("buildReadImmediateResponse", () => {
  it("**AID は 0**（利用者が押した鍵ではない）", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "TARO");
    const d = dataOf(buildReadImmediateResponse(b, codec, { row: 6, col: 33 }).record);
    expect(d.slice(0, 3)).toEqual([6, 33, 0]);
  });

  it("レコードの opcode は PUT_GET（2 実装が一致する点）", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "X");
    expect(parseRecord(buildReadImmediateResponse(b, codec).record).opcode).toBe(OPCODE.PUT_GET);
  });

  it("**欄ごとの MDT を見ない**——1 つでも変更されていれば全ての欄を送る", () => {
    const b = makeBuffer();
    // 1 つ目だけ打つ。2 つ目は MDT が立たない
    b.setFieldValue(b.fieldByIndex(1), "TARO");
    const d = dataOf(buildReadImmediateResponse(b, codec, { row: 1, col: 1 }).record);
    // 欄 1: SBA(5,25) + "TARO"
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 5, 25]);
    expect(d.slice(6, 10)).toEqual([...codec.encode("TARO").bytes]);
    // **欄 2 も来る**（MDT が立っていなくても）
    expect(d.slice(10, 13)).toEqual([ORDER.SBA, 6, 25]);
  });

  it("**どの欄も変更されていなければ、欄を 1 つも送らない**（master MDT が門番）", () => {
    const b = makeBuffer();
    const d = dataOf(buildReadImmediateResponse(b, codec, { row: 2, col: 3 }).record);
    expect(d).toEqual([2, 3, 0]); // 行・桁・AID だけ
  });

  it("2 つとも打てば 2 つとも来る", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "AA");
    b.setFieldValue(b.fieldByIndex(2), "BB");
    const d = dataOf(buildReadImmediateResponse(b, codec, { row: 1, col: 1 }).record);
    expect(d.filter((x, i) => x === ORDER.SBA && i >= 3).length).toBe(2);
  });

  it("カーソルを渡さなければ画面のカーソル位置を使う", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "Z");
    const cur = b.rowColOf(b.cursorAddr);
    const d = dataOf(buildReadImmediateResponse(b, codec).record);
    expect(d.slice(0, 2)).toEqual([cur.row, cur.col]);
  });
});

describe("データストリームからの受け口", () => {
  /** `ESC 0x72` だけのレコード（原典どおりパラメータは無い） */
  const stream = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

  it("**0x72 は即応答を要求する**（入力待ちには入らない）", () => {
    const b = makeBuffer();
    const r = applyDataStream(stream(ESC, COMMAND.READ_IMMEDIATE), b, codec, () => undefined);
    expect(r.readImmediateRequested).toBe(true);
    expect(r.readRequested).toBe(false);
    expect(r.unlockKeyboard).toBe(false);
  });

  it("**パラメータを持たない**——後続のコマンドを食わない", () => {
    const b = makeBuffer();
    const warns: string[] = [];
    // 0x72 のあとに CLEAR UNIT を置く。読み飛ばしすぎれば取りこぼす
    const r = applyDataStream(
      stream(ESC, COMMAND.READ_IMMEDIATE, ESC, COMMAND.CLEAR_UNIT),
      b,
      codec,
      (m) => warns.push(m)
    );
    expect(r.readImmediateRequested).toBe(true);
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
  });

  it("**0x83（ALT）も即応答を要求する**（実機で「返さないと固まる」と分かった）", () => {
    const b = makeBuffer();
    const warns: string[] = [];
    const r = applyDataStream(
      stream(ESC, COMMAND.READ_IMMEDIATE_ALT),
      b,
      codec,
      (m) => warns.push(m)
    );
    expect(r.readMdtImmediateAltRequested).toBe(true);
    expect(warns.some((w) => w.includes("応答していない"))).toBe(false);
  });
});

/**
 * **セッションが実際に返信を書き出すか。**
 *
 * この作業の目的は「届いたときにホストを待たせない」こと。応答の中身が正しくても、
 * **セッションが送らなければ意味が無い**ので、そこまで見る。
 */
describe("セッションが READ IMMEDIATE に即応答する", () => {
  /** `ESC 0x72` だけを載せた 12 バイトのレコード（`read-screen-session.test.ts` と同じ形） */
  const READ_IMMEDIATE_RECORD = [
    0x00, 0x0c, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x08, 0x04, 0x72
  ];
  const IAC_EOR = [0xff, 0xef];

  function fakeTransport(): {
    transport: Transport;
    written: Uint8Array[];
    feed: (b: number[]) => void;
  } {
    const written: Uint8Array[] = [];
    let onData: ((d: Uint8Array) => void) | undefined;
    const transport = {
      onData: (cb: (d: Uint8Array) => void) => {
        onData = cb;
      },
      onClose: () => undefined,
      onError: () => undefined,
      send: (d: Uint8Array) => {
        written.push(d);
      },
      close: () => undefined
    } as unknown as Transport;
    return { transport, written, feed: (b) => onData?.(Uint8Array.from(b)) };
  }

  it("**返信を書き出す**（返さないとホストが待ち続ける）", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(
      () => undefined
    );
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...READ_IMMEDIATE_RECORD, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));

    const sent = written.slice(before);
    const rec = sent.find((d) => d[9] === OPCODE.PUT_GET);
    expect(rec, "READ IMMEDIATE の応答が含まれる").toBeDefined();
    // GDS ヘッダは 10 バイト。その直後が 行・桁・AID。**AID は 0**
    // （末尾は `IAC EOR` なので、後ろから数えてはいけない）
    expect(rec?.[12]).toBe(0);
    // 何も変更されていない画面なので欄は 1 つも載らない（ヘッダ 10 ＋ 3 ＋ IAC EOR 2）
    expect(rec?.length).toBe(15);

    await p;
  });
});
