import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadInputFieldsResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { buildReadScreenResponse } from "../src/protocol/save-screen.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **純 DBCS の欄（DDS の G 型。FCW 0x8220）は SO/SI 無しの 2 バイト組で届き、SO/SI 無しの 2 バイト組で返す。**（`20260921-g-field-sosi`）
 *
 * 実機の DDS の G 型・J 型・E 型・O 型（`scripts/build-gtest.mjs` の GTST。930）で確かめた:
 * - ホストは G の欄のデータを **WEA 0x12 0x05 0x81 … 0x12 0x05 0x80** で挟んで、SO/SI 無しの生の DBCS で送る。当 PJ は WEA を読み飛ばし、
 *   組を半角 2 字に読んで文字化けしていた（`､ｱ､ｲ､ｳ`）
 * - ACS が `かきく` を打った G の欄（12 バイト）を返すワイヤは **`44 86 44 87 44 88 40 40 40 40 40 40`**（SO/SI 無し・欄長いっぱい・残りは DBCS 空白 0x4040）。
 *   当 PJ は `0e 44 86 44 87 44 88 0f` を返し、ホストの欄に制御バイトが入って全角が 1 バイトずれた
 * - J の欄は SO…SI を含めた欄長いっぱい（`0e 44 86 44 87 44 88 40 40 40 40 0f`）。当 PJ は字の直後に SI を置いて短く返す（実機で動いているので変えない）
 */
const codec = codecForCcsid(930);
// 実機が送った WTD（GTST の GREC。ヘッダ 10 バイトを除く。`04 40`＝CLEAR UNIT から `04 52`＝READ MDT FIELDS まで）
const GTST_WTD = Uint8Array.from(Buffer.from("044004110028010700000018000004150009d960018000000011010220c740c6c9c5d3c440e3c5e2e32011030220c740d7e4d9c57a201103131d4020822024000c11050220d140d6d5d3e87a201105131d4020820024000c0e448144824483404040400f11070220c540c5c9e3c8c5d97a201107131d4020824024000cc1c2c300000000000000000011090220d640d6d7c5d57a201109131d4020828024000cc1c1400e448144820f40c2c21103132412058144814482448340404040404012058004520000", "hex"));
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

function applied(bytes: Uint8Array = GTST_WTD, cdc = codec) {
  const buf = new ScreenBuffer();
  const warns: string[] = [];
  const result = applyDataStream(bytes, buf, cdc, (w) => warns.push(w));
  return { buf, warns, result };
}
const rowText = (buf: ScreenBuffer, row: number): string =>
  (buf.snapshot("t", false).cells[row - 1] ?? []).map((c) => c.char).join("").replace(/ +$/, "");

describe("純 DBCS の欄（G）の受信", () => {
  it("**実機の WTD: G の欄が全角で読める**（WEA5 の 0x81／0x80 に挟まれた SO/SI 無しの組）。警告も出ない", () => {
    const { buf, warns } = applied();
    expect(warns).toEqual([]);
    expect(rowText(buf, 3)).toContain("あいう"); // 文字化けの `､ｱ､ｲ､ｳ` ではない
    const g = buf.snapshot("t", false).fields[0]!;
    expect(g).toMatchObject({ row: 3, col: 20, length: 12, dbcsType: "pure" });
  });

  it("G の欄のセルは lead/tail の組で、SO/SI の桁は無い（欄の 12 桁がそのまま 6 字）", () => {
    const { buf } = applied();
    const cells = buf.snapshot("t", false).cells[2]!.slice(19, 31);
    expect(cells.map((c) => c.kind)).toEqual(Array.from({ length: 6 }, () => ["dbcs-lead", "dbcs-tail"]).flat());
    expect(cells.filter((c) => c.kind === "dbcs-lead").map((c) => c.char).join("")).toBe("あいう　　　");
  });

  it("**WEA が無くても、G の欄の中に置かれた組は全角で読める**（ACS は SF の受理で欄の全桁を DBCS の対として印付ける）", () => {
    // SBA(3,19) SF(FFW 4020・FCW 8220・属性 20・長さ 12) の直後に、SO/SI 無しの 6 バイト（あいう）＋ DBCS 空白 3
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 19, ORDER.SF, 0x40, 0x20, 0x82, 0x20, 0x20, 0x00, 0x0c,
      0x44, 0x81, 0x44, 0x82, 0x44, 0x83, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40
    ]);
    const { buf, warns } = applied(bytes);
    expect(warns).toEqual([]);
    expect(rowText(buf, 3)).toContain("あいう");
  });

  it("**WEA5 の 0x81／0x80 の区間は、欄の外でも SO/SI 無しの組として読む**（ACS `isInExtNLSSegment`。0x80 で区間が終わり、その後ろは半角）", () => {
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 2, 5,
      ORDER.WEA, 0x05, 0x81, 0x44, 0x81, 0x44, 0x82, ORDER.WEA, 0x05, 0x80,
      ...codecForCcsid(930).encode("AB").bytes
    ]);
    const { buf, warns } = applied(bytes);
    expect(warns).toEqual([]);
    expect(rowText(buf, 2)).toContain("あいAB");
  });

  it("**G の欄の直後の桁は、欄の外**（欄の終わりの次に置いた半角は組にしない）", () => {
    // G（(3,20) から 12 桁）の後ろ（3,32）に、属性なしで半角 2 字
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 19, ORDER.SF, 0x40, 0x20, 0x82, 0x20, 0x20, 0x00, 0x0c,
      0x44, 0x81, 0x44, 0x82, 0x44, 0x83, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      ORDER.SBA, 3, 32,
      ...codecForCcsid(930).encode("AB").bytes
    ]);
    const { buf } = applied(bytes);
    expect(rowText(buf, 3)).toContain("あいう");
    expect(rowText(buf, 3).endsWith("AB")).toBe(true);
  });

  // ~~WEA5 の 0x00 は区間を外す（0x81 の後でも、その先は半角に戻る）~~ → ACS `PS5250.writeExtAttribute` の `case 0` は現在位置の印を外すだけで、
  // 区間の旗（`isInExtNLSSegment`）は変えない。0x00 で区間を終えるという実装は原典・実測の裏づけの無い推測だった（独立点検 A-S3）。ACS のコアでの測定は未実施
  it("**WEA5 の 0x00 は区間の旗を変えない**（0x81 の後に 0x00 が来ても、0x80 が来るまで SO/SI 無しの組のまま。ACS の `case 0` は印を外すだけ）", () => {
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 2, 5,
      ORDER.WEA, 0x05, 0x81, 0x44, 0x81, ORDER.WEA, 0x05, 0x00, 0x44, 0x82, ORDER.WEA, 0x05, 0x80,
      ...codecForCcsid(930).encode("AB").bytes
    ]);
    const { buf, warns } = applied(bytes);
    expect(warns).toEqual([]);
    expect(rowText(buf, 2)).toContain("あいAB");
  });

  it("**奇数バイトの後ろにオーダーが来ても、組の 2 バイト目に食わない**（未閉じの WEA5 の区間・偶数に足りない G の欄。偽の否定応答で後ろの SBA・READ を失わない。独立点検 A-S2）", () => {
    // WEA5 0x81 で始めて 0x80 が来ないまま、奇数バイト（C1）の後ろに SBA が続く
    const unclosed = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 2, 5, ORDER.WEA, 0x05, 0x81, 0xc1,
      ORDER.SBA, 4, 5, ...codecForCcsid(930).encode("XY").bytes,
      ESC, 0x52, 0x00, 0x00
    ]);
    const a = applied(unclosed);
    expect(a.warns.filter((w) => w.includes("expected ESC")), "偽の否定応答（レコードの残りを捨てる）を出さない").toEqual([]);
    expect(a.result.senseCode, "否定応答を返さない").toBeUndefined();
    expect(a.result.readRequested, "後ろの READ を失わない").toBe(true);
    // 区間の中の奇数バイトの後ろに WEA 0x80 が来る
    const oddThenEnd = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 2, 5, ORDER.WEA, 0x05, 0x81, 0x44, 0x81, 0xc1, ORDER.WEA, 0x05, 0x80,
      ORDER.SBA, 4, 5, ...codecForCcsid(930).encode("XY").bytes
    ]);
    const b = applied(oddThenEnd);
    expect(b.warns.filter((w) => w.includes("expected ESC"))).toEqual([]);
    expect(rowText(b.buf, 2)).toContain("あ");
    expect(rowText(b.buf, 4)).toContain("XY");
  });

  it("G でない欄（J・E・O）は従来どおり（SO/SI で挟まれた組だけが全角）", () => {
    const { buf } = applied();
    expect(rowText(buf, 5)).toContain("あいう"); // J: SO…SI
    expect(rowText(buf, 9)).toContain("AA");
    expect(rowText(buf, 9)).toContain("あい");
    expect(rowText(buf, 9)).toContain("BB");
  });

  it("**DBCS でないコードページでは従来どおり**（WEA5 は警告して読み飛ばし、組は半角として読む）", () => {
    const { warns } = applied(GTST_WTD, codecForCcsid(37));
    expect(warns.some((w) => w.startsWith("WEA order (type=0x5"))).toBe(true);
  });
});

describe("純 DBCS の欄（G）の送信", () => {
  const cursor = { row: 3, col: 20 };
  const gField = (buf: ScreenBuffer) => buf.orderedFields()[0]!;

  it("**打った `かきく` は欄長いっぱいの SO/SI 無しで返す**（実機の ACS のワイヤと同じ 12 バイト）", () => {
    const { buf } = applied();
    buf.setFieldValue(gField(buf), "かきく", true);
    const { record } = buildReadMdtResponse(buf, codec, AID.ENTER, cursor);
    const data = hex(parseRecord(record).data);
    expect(data, "SBA(3,20) の後ろに SO/SI 無しの 12 バイト").toContain("11 03 14 44 86 44 87 44 88 40 40 40 40 40 40");
    expect(data.includes("0e"), "制御バイト（SO）を含まない").toBe(false);
  });

  it("**未編集の G の欄も、ホストの原本のバイトをそのまま返す**（SO/SI を足さない）", () => {
    const { buf } = applied();
    gField(buf).mdt = true;
    const data = hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, cursor).record).data);
    expect(data).toContain("11 03 14 44 81 44 82 44 83 40 40 40 40 40 40");
  });

  it("欄より長い値は欄長（12 バイト＝6 字）で切る", () => {
    const { buf } = applied();
    buf.setFieldValue(gField(buf), "かきくけこさし", true); // 7 字＝14 バイト
    const data = hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, cursor).record).data);
    const six = codec.encode("かきくけこさ").bytes; // SO 12 バイト SI
    expect(data.endsWith("11 03 14 " + hex(six.subarray(1, six.length - 1))), "6 字ちょうどで終わる（7 字目は送らない）").toBe(true);
  });

  it("**J の欄は従来どおり**（SO…SI で挟む）", () => {
    const { buf } = applied();
    const j = buf.orderedFields()[1]!;
    buf.setFieldValue(j, "かきく", true);
    const data = hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 20 }).record).data);
    expect(data).toContain("11 05 14 0e 44 86 44 87 44 88 0f");
  });

  it("平坦な応答（READ INPUT FIELDS）の G の欄も SO/SI 無しで、欄長にそろえる", () => {
    const { buf } = applied();
    gField(buf).mdt = true;
    buf.setFieldValue(gField(buf), "かきく", true);
    const data = hex(parseRecord(buildReadInputFieldsResponse(buf, codec, AID.ENTER, cursor).record).data);
    expect(data).toContain("44 86 44 87 44 88 40 40 40 40 40 40");
    expect(data.slice(0, 40).includes("0e")).toBe(false);
  });
});

describe("純 DBCS の欄（G）の画面イメージ（READ SCREEN・SAVE/RESTORE の往復）", () => {
  it("**G の欄は受け取ったバイトのまま戻る**（SO/SI を足さない・組が崩れない）", () => {
    const { buf } = applied();
    const data = hex(parseRecord(buildReadScreenResponse(buf, codec, 0x00)).data);
    expect(data).toContain("44 81 44 82 44 83 40 40 40 40 40 40");
    const at = data.indexOf("44 81 44 82 44 83 40 40 40 40 40 40");
    expect(data.slice(Math.max(0, at - 3), at), "G の直前に SO が入らない").not.toContain("0e");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 独立点検 A（節目 11）の指摘: `Session.setField`・継続 G・奇数の値・欄長の丸め
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { OPCODE } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

function rx(record: Uint8Array): TraceEntry {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

describe("Session.setField（G の欄）は SO/SI を数えない（A-M1）", () => {
  async function session() {
    return Session5250.connect({ transport: new ReplayTransport([rx(buildRecord(OPCODE.PUT_GET, GTST_WTD))]), id: "t", ccsid: 930 });
  }

  it("**全角 6 字（12 バイト）が入る**（SO/SI を数えると 14 バイトで FIELD_OVERFLOW だった。ブラウザの Enter・MCP・HLLAPI・マクロが通る経路）", async () => {
    const s = await session();
    expect(() => s.setField({ index: 1 }, "あいうえおか")).not.toThrow();
    expect(() => s.setField({ index: 1 }, "あいうえお")).not.toThrow();
  });

  it("7 字（14 バイト）は FIELD_OVERFLOW", async () => {
    const s = await session();
    expect(() => s.setField({ index: 1 }, "あいうえおかき")).toThrow(/at most 12 bytes/);
  });

  it("J（SO/SI 込み）は従来どおり 5 字までで、6 字は FIELD_OVERFLOW", async () => {
    const s = await session();
    expect(() => s.setField({ index: 2 }, "あいうえお")).not.toThrow();
    expect(() => s.setField({ index: 2 }, "あいうえおか")).toThrow(/at most 12 bytes/);
  });
});

describe("継続入力の G の欄（A-S1）", () => {
  /** SF（FFW 4000・FCW 8220 と 86xx・属性 24・長さ）。`cont`: 0x01＝先頭・0x02＝最終 */
  const sfG = (row: number, col: number, len: number, cont: number): number[] => [
    ORDER.SBA, row, col, ORDER.SF, 0x40, 0x00, 0x82, 0x20, 0x86, cont, 0x24, (len >> 8) & 0xff, len & 0xff
  ];
  const raw10 = (from: number): number[] => [0x44, from, 0x44, from + 1, 0x44, from + 2, 0x44, from + 3, 0x44, from + 4];
  function two(seg1: number[], seg2: number[]) {
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ...sfG(5, 19, 10, 0x01), ...seg1, ...sfG(6, 19, 10, 0x02), ...seg2
    ]);
    return applied(bytes).buf;
  }
  const mdt = (buf: ScreenBuffer) => hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 5, col: 20 }).record).data);
  const flat = (buf: ScreenBuffer) => hex(parseRecord(buildReadInputFieldsResponse(buf, codec, AID.ENTER, { row: 5, col: 20 }).record).data);

  it("**未編集: 全区間（20 バイト）を送る**（先頭区間の 10 バイトで切らない。READ MDT と READ INPUT FIELDS で同じ）", () => {
    const buf = two(raw10(0x81), raw10(0x86));
    buf.fieldByIndex(1).mdt = true;
    const all = hex([...raw10(0x81), ...raw10(0x86)]);
    expect(mdt(buf)).toContain(`11 05 14 ${all}`);
    expect(flat(buf)).toContain(all);
  });

  it("**編集済み: 区間ごとに全角空白で詰めてから連結する**（SO/SI 無し・区間の境に半角空白が混ざらない・後ろの区間の字が前の空きへ詰まらない）", () => {
    const buf = two(raw10(0x81), raw10(0x86));
    buf.setFieldValue(buf.fieldByIndex(1), "かきく", true); // 先頭区間: 3 字＋空き 2 スロット
    buf.setFieldValue(buf.fieldByIndex(2), "さし", true); // 最終区間: 2 字＋空き 3 スロット
    const enc = (t: string) => hex(codec.encode(t).bytes.subarray(1, codec.encode(t).bytes.length - 1));
    const expected = `${enc("かきく")} 40 40 40 40 ${enc("さし")} 40 40 40 40 40 40`; // 先頭 10 バイト＝かきく＋□□、最終 10 バイト＝さし＋□□□
    const m = mdt(buf);
    expect(m).toContain(`11 05 14 ${expected}`);
    expect(m.includes(" 0e "), "SO を含まない").toBe(false);
    expect(flat(buf)).toContain(expected);
  });
});

describe("純 DBCS の欄の送信の細部（A-S4）", () => {
  it("**半角が混ざった値は SO/SI を外さない**（中に SO/SI がある符号化は、外すと壊れる。G には入らない値の防御）", () => {
    const { buf } = applied();
    const g = buf.orderedFields()[0]!;
    buf.setFieldValue(g, "あAい", true);
    const data = hex(parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 3, col: 20 }).record).data);
    // 符号化そのまま（先頭の SO も残る。詰め物の全角空白が末尾の連なりに足されるので、SI の位置までは比べない）。
    // 外すと `44 81 0f c1 0e 44 82` の壊れた並びになる
    expect(data).toContain(hex(codec.encode("あAい").bytes.subarray(0, 8)));
  });

  it("**欄長が奇数なら偶数へ丸める**（11 バイトの G は 10 バイト送る。組を割らない）", () => {
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 19, ORDER.SF, 0x40, 0x00, 0x82, 0x20, 0x24, 0x00, 0x0b,
      0x44, 0x81, 0x44, 0x82, 0x44, 0x83, 0x44, 0x84, 0x44, 0x85, 0x40
    ]);
    const { buf } = applied(bytes);
    const g = buf.orderedFields()[0]!;
    g.mdt = true;
    const data = parseRecord(buildReadMdtResponse(buf, codec, AID.ENTER, { row: 3, col: 20 }).record).data;
    // カーソル 2 バイト＋AID 1 バイト＋SBA 3 バイトの後ろが 10 バイト
    expect(data.length - 6).toBe(10);
  });
});
