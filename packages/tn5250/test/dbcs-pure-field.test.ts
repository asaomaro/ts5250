import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadInputFieldsResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { buildReadScreenResponse } from "../src/protocol/save-screen.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **純 DBCS の欄（DDS の G 型。FCW 0x8220）は SO/SI 無しの 2 バイト組で届き、SO/SI 無しの 2 バイト組で返す。**（`20260922-g-field-sosi`）
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
  applyDataStream(bytes, buf, cdc, (w) => warns.push(w));
  return { buf, warns };
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

  it("WEA5 の 0x00 は区間を外す（0x81 の後でも、その先は半角に戻る）", () => {
    const bytes = Uint8Array.from([
      ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 2, 5,
      ORDER.WEA, 0x05, 0x81, 0x44, 0x81, ORDER.WEA, 0x05, 0x00,
      ...codecForCcsid(930).encode("AB").bytes
    ]);
    const { buf } = applied(bytes);
    expect(rowText(buf, 2)).toContain("あAB");
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
