import { describe, it, expect } from "vitest";
import {
  buildExchangeAttributes,
  buildCreate,
  buildDelete,
  buildWrite,
  buildRead,
  buildClear,
  buildRequestAttributes,
  replyId,
  commonReplyRc,
  decodeEbcdic,
  parseReadReply,
  parseAttributesReply,
  parseCpfId,
  dtaqFailure,
  DTAQ_SERVER_ID,
  DTAQ_REQ,
  DTAQ_REPLY,
  DTAQ_RC
} from "../src/hostserver/dtaq/dtaq-datastream.js";
import { Tn5250Error } from "../src/errors.js";

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** ヘッダー共通部（全長/サーバー ID/テンプレート長/ReqRep ID）を検証する */
function expectHeader(frame: Uint8Array, total: number, templateLen: number, reqId: number): void {
  const v = view(frame);
  expect(frame.length).toBe(total);
  expect(v.getUint32(0)).toBe(total);
  expect(v.getUint16(6)).toBe(DTAQ_SERVER_ID);
  expect(v.getUint16(16)).toBe(templateLen);
  expect(v.getUint16(18)).toBe(reqId);
}

/** EBCDIC(CCSID273) の英数字を直接組む（テストを codec 実装に依存させない） */
const EBCDIC: Record<string, number> = {
  Q: 0xd8, U: 0xe4, S: 0xe2, E: 0xc5, R: 0xd9, C: 0xc3, P: 0xd7, F: 0xc6, H: 0xc8, Z: 0xe9, G: 0xc7,
  "0": 0xf0, "1": 0xf1, "2": 0xf2, "3": 0xf3, "4": 0xf4, "5": 0xf5,
  "6": 0xf6, "7": 0xf7, "8": 0xf8, "9": 0xf9
};
function ebcdic(text: string): number[] {
  return [...text].map((ch) => {
    const b = EBCDIC[ch];
    if (b === undefined) throw new Error(`no EBCDIC fixture for '${ch}'`);
    return b;
  });
}

describe("dtaq datastream ビルダ", () => {
  it("交換属性（0x0000）: 全長26 / テンプレート6 / クライアント版1", () => {
    const f = buildExchangeAttributes();
    expectHeader(f, 26, 6, DTAQ_REQ.exchangeAttributes);
    expect(view(f).getUint32(20)).toBe(0x00000001);
  });

  it("作成（0x0003）: type バイトと keyLength を書く", () => {
    const f = buildCreate({ name: "TESTDQ", library: "MYLIB", maxEntryLength: 200, type: "KEYED", keyLength: 16, saveSender: true });
    expectHeader(f, 100, 80, DTAQ_REQ.create);
    expect(view(f).getUint32(40)).toBe(200); // 最大エントリ長
    expect(f[45]).toBe(0xf1); // saveSender=true
    expect(f[46]).toBe(0xf2); // KEYED
    expect(view(f).getUint16(47)).toBe(16); // keyLength
  });

  it("作成: FIFO / LIFO の type バイト", () => {
    expect(buildCreate({ name: "Q", library: "L", maxEntryLength: 10, type: "FIFO" })[46]).toBe(0xf0);
    expect(buildCreate({ name: "Q", library: "L", maxEntryLength: 10, type: "LIFO" })[46]).toBe(0xf1);
  });

  it("送信（0x0005）非キー: エントリを LL/CP=0x5001 で載せる", () => {
    const entry = new TextEncoder().encode("hello");
    const f = buildWrite("Q", "L", entry);
    expectHeader(f, 48 + entry.length, 22, DTAQ_REQ.write);
    expect(f[40]).toBe(0xf0); // キーなし
    const v = view(f);
    expect(v.getUint32(42)).toBe(entry.length + 6); // LL
    expect(v.getUint16(46)).toBe(0x5001); // CP エントリ
    expect(new TextDecoder().decode(f.subarray(48, 48 + entry.length))).toBe("hello");
  });

  it("送信 キー付き: キーを LL/CP=0x5002 で載せる", () => {
    const entry = new TextEncoder().encode("v");
    const key = new TextEncoder().encode("KK");
    const f = buildWrite("Q", "L", entry, key);
    expect(f[40]).toBe(0xf1); // キー付き
    expect(f.length).toBe(54 + entry.length + key.length);
    const v = view(f);
    // エントリ（LL/CP/data） の後にキー（LL/CP=0x5002/data）
    const keyAt = 48 + entry.length;
    expect(v.getUint32(keyAt)).toBe(key.length + 6);
    expect(v.getUint16(keyAt + 4)).toBe(0x5002);
  });

  it("受信（0x0002）: 待機秒 int32・ピーク・キー検索を書く", () => {
    const f = buildRead({ name: "Q", library: "L", wait: -1, peek: true });
    expectHeader(f, 48, 28, DTAQ_REQ.read);
    expect(view(f).getInt32(43)).toBe(-1); // 無限待ち
    expect(f[47]).toBe(0xf1); // peek
  });

  it("受信 キー付き: 検索順を EBCDIC 2 バイトで書き、キーを載せる", () => {
    const key = new TextEncoder().encode("KEY0");
    const f = buildRead({ name: "Q", library: "L", wait: 0, key, search: "GE" });
    expect(f[40]).toBe(0xf1);
    // 検索順 "GE" が EBCDIC で offset41-42（G=0xc7,E=0xc5）
    expect(f[41]).toBe(0xc7);
    expect(f[42]).toBe(0xc5);
    const v = view(f);
    expect(v.getUint32(48)).toBe(key.length + 6);
    expect(v.getUint16(52)).toBe(0x5002);
  });

  it("クリア（0x0006）/ 削除（0x0004）/ 属性（0x0001）のヘッダー", () => {
    expectHeader(buildClear("Q", "L"), 41, 21, DTAQ_REQ.clear);
    expectHeader(buildDelete("Q", "L"), 40, 20, DTAQ_REQ.delete);
    expectHeader(buildRequestAttributes("Q", "L"), 40, 20, DTAQ_REQ.requestAttributes);
  });
});

describe("dtaq 応答パーサ", () => {
  /** research F2 で実機採取した受信正常応答（0x8003, 69 バイト） */
  const READ_REPLY = Uint8Array.from([
    0x00, 0x00, 0x00, 0x45, 0x00, 0x00, 0xe0, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x26, 0x80, 0x03, 0xf0, 0x00, 0xd8, 0xe9, 0xc8, 0xd8, 0xe2, 0xe2, 0xd9, 0xe5, 0x40, 0x40,
    0xd8, 0xe4, 0xe2, 0xc5, 0xd9, 0x40, 0x40, 0x40, 0x40, 0x40, 0xf9, 0xf7, 0xf7, 0xf2, 0xf1, 0xf1,
    0xe4, 0xe2, 0xc5, 0xd9, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x00, 0x00, 0x00, 0x0b, 0x50, 0x01,
    0x66, 0x69, 0x72, 0x73, 0x74
  ]);

  it("受信応答は offset58 の LL/CP からデータ、offset22 から送信者情報（実機ダンプ）", () => {
    expect(replyId(READ_REPLY)).toBe(DTAQ_REPLY.read);
    const entry = parseReadReply(READ_REPLY);
    expect(new TextDecoder().decode(entry.data)).toBe("first");
    expect(entry.senderInfo).toBeDefined();
    expect(entry.senderInfo?.length).toBe(36);
    expect(entry.senderInfo?.[0]).toBe(0xd8); // "Q"（送信者情報あり）
  });

  it("送信者情報の先頭が 0x40（スペース）なら senderInfo を落とす", () => {
    const noSender = READ_REPLY.slice();
    noSender.fill(0x40, 22, 58);
    const entry = parseReadReply(noSender);
    expect(entry.senderInfo).toBeUndefined();
    expect(new TextDecoder().decode(entry.data)).toBe("first");
  });

  it("属性応答（0x8001）を解く: maxEntryLength/saveSender/type/keyLength", () => {
    const f = new Uint8Array(30);
    const v = view(f);
    v.setUint16(18, DTAQ_REPLY.requestAttributes);
    v.setUint32(22, 512); // maxEntryLength
    f[26] = 0xf1; // saveSender
    f[27] = 0x02; // KEYED
    v.setUint16(28, 8); // keyLength
    const attrs = parseAttributesReply(f);
    expect(attrs).toEqual({ maxEntryLength: 512, saveSender: true, type: "KEYED", keyLength: 8 });
  });
});

describe("dtaqFailure（rc + CPF → 区別できるエラー）", () => {
  /** rc と、フレーム中に CPF メッセージを埋めた偽 0x8002 を作る */
  function commonReply(rc: number, cpf?: string): Uint8Array {
    const body = cpf ? ebcdic(cpf) : [];
    const f = new Uint8Array(22 + body.length + 4);
    const v = view(f);
    v.setUint16(18, DTAQ_REPLY.common);
    v.setUint16(20, rc);
    f.set(body, 24);
    return f;
  }

  it("CPF9801（オブジェクトなし）→ NOT_FOUND", () => {
    expect(dtaqFailure("read", commonReply(DTAQ_RC.commandCheck, "CPF9801")).code).toBe("NOT_FOUND");
  });
  it("CPF9802（権限なし）→ ACCESS_DENIED", () => {
    expect(dtaqFailure("read", commonReply(DTAQ_RC.commandCheck, "CPF9802")).code).toBe("ACCESS_DENIED");
  });
  it("CPF9870（既存）→ ALREADY_EXISTS", () => {
    expect(dtaqFailure("create", commonReply(DTAQ_RC.commandCheck, "CPF9870")).code).toBe("ALREADY_EXISTS");
  });
  it("rc=0xF002（キー不整合）→ CONFIG_ERROR", () => {
    expect(dtaqFailure("read", commonReply(DTAQ_RC.keyMismatch)).code).toBe("CONFIG_ERROR");
  });
  it("未知の rc/CPF → PROTOCOL_ERROR", () => {
    expect(dtaqFailure("read", commonReply(0xf099)).code).toBe("PROTOCOL_ERROR");
  });
  it("共通応答でない ID → unexpected reply", () => {
    const f = new Uint8Array(22);
    view(f).setUint16(18, DTAQ_REPLY.read);
    const e = dtaqFailure("attributes", f);
    expect(e).toBeInstanceOf(Tn5250Error);
    expect(e.message).toMatch(/unexpected reply 0x8003/);
  });

  it("parseCpfId はフレーム中の CPF を位置に依らず拾う", () => {
    const f = new Uint8Array(40);
    f.set(ebcdic("CPF9801"), 30); // どこにあっても拾える
    expect(parseCpfId(f)).toBe("CPF9801");
  });
  it("parseCpfId は CPF が無ければ undefined", () => {
    expect(parseCpfId(commonReply(DTAQ_RC.noData))).toBeUndefined();
  });

  it("commonReplyRc は 22 バイト未満のフレームで PROTOCOL_ERROR（生の RangeError にしない）", () => {
    const shortFrame = new Uint8Array(21); // replyId は通るが rc(20-21) が読めない
    view(shortFrame).setUint16(18, DTAQ_REPLY.common);
    expect(() => commonReplyRc(shortFrame)).toThrow(Tn5250Error);
    expect(() => commonReplyRc(shortFrame)).toThrow(/too short/);
  });
});

describe("decodeEbcdic（末尾スペースだけ落とす）", () => {
  it("末尾の詰めスペース（0x40）を落とす", () => {
    // "AB" + 0x40*3（EBCDIC: A=0xc1 B=0xc2）
    expect(decodeEbcdic(Uint8Array.from([0xc1, 0xc2, 0x40, 0x40, 0x40]))).toBe("AB");
  });

  it("フィールドが '@'（variant 文字）で終わっても取りこぼさない", () => {
    // CCSID273 の '@' は 0xB5（0x7c は '§'）。詰めスペース無しで末尾が '@' のとき、
    // デコード後文字列に対する 0x40 除去だと '@' を消してしまっていた（回帰）
    expect(decodeEbcdic(Uint8Array.from([0xc1, 0xb5]))).toBe("A@");
  });
});
