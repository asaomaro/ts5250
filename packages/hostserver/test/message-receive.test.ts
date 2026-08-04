/**
 * `QMHRCVM` の組み立てと `RCVM0200` の読み取り。
 *
 * **並びは実機で当てたもの**（`message-receive.ts` の docblock）。
 * ここで固定しておかないと、順番を入れ替えても**失敗せずに嘘の値**が返る——
 * 実際、待ち時間と種別を取り違えたときは `CPF24B3` になるまで気づけなかった。
 */
import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic";
import {
  buildReceiveParams,
  parseReceivedMessage,
  messageKeyToBytes,
  INQUIRY_TYPE
} from "../src/command/message-receive.js";

const CCSID = 37;
const codec = codecForCcsid(CCSID);
const dataOf = (p: ReturnType<typeof buildReceiveParams>[number]): Uint8Array =>
  "data" in p && p.data ? p.data : new Uint8Array(0);

const base = { name: "QSYSOPR", library: "QSYS", wait: -1, ccsid: CCSID } as const;

describe("buildReceiveParams", () => {
  it("実機で当てた並びで組む（種別→キー→待ち時間の順）", () => {
    const p = buildReceiveParams({ ...base, selector: "*NEXT", key: messageKeyToBytes("00000180") });
    expect(p).toHaveLength(9);
    expect(codec.decode(dataOf(p[2]!))).toBe("RCVM0200");
    // 修飾名は**待ち行列(10) ＋ ライブラリー(10)**
    expect(codec.decode(dataOf(p[3]!))).toBe("QSYSOPR   QSYS      ");
    expect(codec.decode(dataOf(p[4]!))).toBe("*NEXT     ");
    expect([...dataOf(p[5]!)]).toEqual([0x00, 0x00, 0x01, 0x80]);
    // 待ち時間は**キーの後ろ**（前に置くと CPF24B3 になる）
    expect(new DataView(dataOf(p[6]!).buffer).getInt32(0)).toBe(-1);
    expect(codec.decode(dataOf(p[7]!))).toBe("*SAME     ");
  });

  it("キーを省くと**空白**になる（0 埋めは CPF2551 で断られる）", () => {
    const p = buildReceiveParams({ ...base, selector: "*FIRST" });
    expect([...dataOf(p[5]!)]).toEqual([0x40, 0x40, 0x40, 0x40]);
  });

  it("受け取り域の大きさが第 2 引数と一致する（食い違うと器の外を読む）", () => {
    const p = buildReceiveParams({ ...base, selector: "*ANY", bufferBytes: 1024 });
    expect(p[0]).toEqual({ type: "out", length: 1024 });
    expect(new DataView(dataOf(p[1]!).buffer).getInt32(0)).toBe(1024);
  });

  it("固定部より小さい器は断る（読めない器を渡してもホストは教えてくれない）", () => {
    expect(() => buildReceiveParams({ ...base, selector: "*ANY", bufferBytes: 100 })).toThrow(/176/u);
  });

  it("4 バイトでないキーは断る", () => {
    expect(() => buildReceiveParams({ ...base, selector: "*NEXT", key: new Uint8Array(8) })).toThrow(/4 バイト/u);
  });

  it("16 進 8 桁でないキーは断る", () => {
    expect(() => messageKeyToBytes("00 0180")).toThrow(/16 進/u);
  });
});

/** `RCVM0200` の受け取り域を組み立てる（実機と同じ並び） */
function buffer(opts: {
  id?: string;
  type?: string;
  key?: number[];
  severity?: number;
  data?: string;
  text?: string;
  help?: string;
  available?: number;
}): Uint8Array {
  const enc = (t: string) => codec.encode(t).bytes;
  const data = enc(opts.data ?? "");
  const text = enc(opts.text ?? "");
  const help = enc(opts.help ?? "");
  const returned = 176 + data.length + text.length + help.length;
  const buf = new Uint8Array(4096).fill(0x40);
  const view = new DataView(buf.buffer);
  view.setInt32(0, returned);
  view.setInt32(4, opts.available ?? returned);
  view.setInt32(8, opts.severity ?? 0);
  buf.set(enc((opts.id ?? "").padEnd(7)), 12);
  buf.set(enc(opts.type ?? "04"), 19);
  buf.set(Uint8Array.from(opts.key ?? [0, 0, 1, 0x80]), 21);
  view.setInt32(152, data.length);
  view.setInt32(156, data.length);
  view.setInt32(160, text.length);
  view.setInt32(164, text.length);
  view.setInt32(168, help.length);
  view.setInt32(172, help.length);
  buf.set(data, 176);
  buf.set(text, 176 + data.length);
  buf.set(help, 176 + data.length + text.length);
  return buf;
}

describe("parseReceivedMessage", () => {
  it("実機と同じ位置から読む", () => {
    const m = parseReceivedMessage(
      buffer({ id: "CPA3303", type: "05", severity: 99, text: "Attributes of file QPDSPJOB not supported." }),
      CCSID
    );
    expect(m).toMatchObject({
      key: "00000180",
      id: "CPA3303",
      typeCode: "05",
      type: "INQUIRY",
      severity: 99,
      inquiry: true,
      text: "Attributes of file QPDSPJOB not supported.",
      truncated: false
    });
  });

  it("**置換データのぶん本文がずれる**（位置を決め打ちしていない）", () => {
    const m = parseReceivedMessage(buffer({ data: "PRT_TEST  QSPLJOB   081408", text: "Writer started." }), CCSID);
    expect(m?.text).toBe("Writer started.");
  });

  it("二次レベルは本文の後ろから読む", () => {
    // **CCSID 37 で表せる字だけを使う**（日本語を混ぜると置換されて、
    // 位置の検証ではなく符号化の検証になってしまう）
    const m = parseReceivedMessage(buffer({ text: "Writer started.", help: "Cause . . . :  none" }), CCSID);
    expect(m?.text).toBe("Writer started.");
    expect(m?.help).toBe("Cause . . . :  none");
  });

  it("**何も無いときは undefined**（待ち時間が尽きたとき。実機の返りは 8）", () => {
    const empty = new Uint8Array(4096);
    new DataView(empty.buffer).setInt32(0, 8);
    expect(parseReceivedMessage(empty, CCSID)).toBeUndefined();
  });

  it("器が空・短すぎるときも undefined（落とさない）", () => {
    expect(parseReceivedMessage(undefined, CCSID)).toBeUndefined();
    expect(parseReceivedMessage(new Uint8Array(4), CCSID)).toBeUndefined();
  });

  it("**切れたことが分かる**（器に収まらなかった）", () => {
    const m = parseReceivedMessage(buffer({ text: "cut here", available: 9999 }), CCSID);
    expect(m?.truncated).toBe(true);
  });

  it("即時メッセージは ID が空", () => {
    const m = parseReceivedMessage(buffer({ text: "hello" }), CCSID);
    expect(m?.id).toBe("");
    expect(m?.type).toBe("INFORMATIONAL");
    expect(m?.inquiry).toBe(false);
  });

  it("**即時メッセージは置換データの側に本文が入る**（実機の SNDMSG がこの形）", () => {
    // `SNDMSG MSG('...')` は ID を持たず、本文の長さ 0 ／ 置換データに打った文字が入る
    const m = parseReceivedMessage(buffer({ data: "sent by SNDMSG" }), CCSID);
    expect(m?.id).toBe("");
    expect(m?.text).toBe("sent by SNDMSG");
  });

  it("ファイル由来は本文の欄を読む（置換データは素の値なので出さない）", () => {
    const m = parseReceivedMessage(
      buffer({ id: "CPI1466", data: "SRBKUP    SUZUKI    081399", text: "Job holds large number of locks." }),
      CCSID
    );
    expect(m?.text).toBe("Job holds large number of locks.");
  });

  it("知らない種別コードはコードのまま返す（黙って落とさない）", () => {
    const m = parseReceivedMessage(buffer({ type: "99" }), CCSID);
    expect(m?.type).toBe("99");
  });

  it("照会の判定は種別コード 05", () => {
    expect(INQUIRY_TYPE).toBe("05");
    expect(parseReceivedMessage(buffer({ type: "05" }), CCSID)?.inquiry).toBe(true);
    expect(parseReceivedMessage(buffer({ type: "06" }), CCSID)?.inquiry).toBe(false);
  });
});
