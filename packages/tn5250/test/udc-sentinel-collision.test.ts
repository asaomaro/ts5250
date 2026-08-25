import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { AID, COMMAND, ESC, ORDER } from "../src/protocol/constants.js";
import {
  isRawSentinel,
  isAttrSentinel,
  rawSentinel,
  attrSentinel,
  sentinelByte,
  stripSentinels
} from "../src/screen/attr-sentinel.js";

/**
 * **外字（UDC）とセンチネルの衝突。**
 *
 * CCSID 930 の外字 0x6941〜0x6A40 は Unicode の私用面 **U+E000〜U+E0FF** へ落ちる。
 * センチネル（生バイト・埋め込み属性を値の中で運ぶ印）も同じ U+E000+byte を使っていたため、
 * **外字とセンチネルが見分けられなかった**。
 *
 * 【実機で分かった不具合】外字を含む DBCS 欄を編集して送ると、外字 1 文字が生バイト 1 つ
 * （0x00）に化けて SO/SI ごと消える（実機 IBM i 7.3・`ASAOLIB/UDCPGM`。
 * `x'0E69410F'` の後ろに `AB` を打って送ると、ホストは外字を失った値を受け取った）。
 * web-ui は DBCS 欄を編集するとき値をセルから組み立て直す（`logicalFromCells`）ので、
 * この経路に必ず乗る。
 *
 * 直し方は**センチネルの基点を単独ローサロゲート（U+DC00+byte）へ移す**こと。
 * BMP の私用面には 256 連続の空きが無い（変換表が U+E000〜U+F83C を埋めている）。
 */

const codec = codecForCcsid(930);
const UDC_HI = 0x69, UDC_LO = 0x41; // 外字の 1 つ目（U+E000 へ落ちる）

/** DBCS open（FCW 0x8280）の入力欄に SO + 外字 + SI が書かれた画面 */
function screenWithUdc(): ScreenBuffer {
  const b = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20,
      ORDER.SBA, 3, 9, ORDER.SF, 0x40, 0x20, 0x82, 0x80, 0x20, 0x00, 0x0a,
      ORDER.SBA, 3, 10, 0x0e, UDC_HI, UDC_LO, 0x0f
    ]),
    b,
    codec,
    () => {}
  );
  return b;
}
/** web-ui の `logicalFromCells` と同じ組み立て（sbcs と dbcs-lead を拾う） */
function logicalFromCells(b: ScreenBuffer): string {
  const cells = b.snapshot("s").cells[2] ?? [];
  return cells
    .slice(9, 19)
    .filter((c) => c?.kind === "sbcs" || c?.kind === "dbcs-lead")
    .map((c) => c!.char)
    .join("")
    .replace(/ +$/, "");
}
const dataOf = (r: Uint8Array): number[] => [...parseRecord(r).data];

describe("外字はセンチネルと衝突しない", () => {
  it("外字は私用面の文字として復号される（U+E000）", () => {
    expect(codec.decodeDbcsPair(UDC_HI, UDC_LO)).toBe(0xe000);
  });

  it("**外字はセンチネルではない**（旧基点なら true になっていた）", () => {
    const udc = String.fromCodePoint(0xe000);
    expect(isRawSentinel(udc)).toBe(false);
    expect(isAttrSentinel(udc)).toBe(false);
    // 私用面の端（0xE0FF = 外字 0x6A40）も同じ
    expect(isRawSentinel(String.fromCodePoint(0xe0ff))).toBe(false);
  });

  it("BMP 外の文字（CCSID 1399 の漢字）もセンチネルと取り違えない", () => {
    // U+2000B は下位サロゲートが U+DC0B＝センチネルの範囲に入る。**符号位置で見る**ので当たらない
    const kanji = String.fromCodePoint(0x2000b);
    expect(isRawSentinel(kanji)).toBe(false);
    expect([...kanji]).toHaveLength(1); // for-of は対を 1 文字として返す
  });

  it("センチネルは 1 コード単位（桁の勘定を崩さない）", () => {
    const s = rawSentinel(0x1c);
    expect(s.length).toBe(1);
    expect(sentinelByte(s)).toBe(0x1c);
    expect(isRawSentinel(s)).toBe(true);
    expect(attrSentinel(0x28).length).toBe(1);
    expect(isAttrSentinel(attrSentinel(0x28))).toBe(true);
  });

  it("表示用の除去は外字を残す（センチネルだけ空白にする）", () => {
    const udc = String.fromCodePoint(0xe000);
    expect(stripSentinels(`A${udc}${rawSentinel(0x9f)}B`)).toBe(`A${udc} B`);
  });
});

describe("外字を含む DBCS 欄の往復（実機 UDCPGM の再現）", () => {
  it("触らずに送り返せば原本のバイトのまま", () => {
    const b = screenWithUdc();
    // MDT を立てるために同じ値を書き戻す（未編集の DBCS 欄の値＝原本バイトのセンチネル列）
    b.setFieldValue(b.fieldByIndex(1), b.snapshot("s").fields[0]!.value);
    const d = dataOf(buildReadMdtResponse(b, codec, AID.ENTER, { row: 3, col: 10 }).record);
    expect(d.slice(0, 6)).toEqual([3, 10, AID.ENTER, ORDER.SBA, 3, 10]);
    expect(d.slice(6)).toEqual([0x0e, UDC_HI, UDC_LO, 0x0f]);
  });

  it("**セル由来の値を編集して送っても外字が壊れない**（実機で DIFF になっていた経路）", () => {
    const b = screenWithUdc();
    const seen = logicalFromCells(b);
    expect([...seen].map((c) => c.codePointAt(0))).toEqual([0xe000]); // 外字 1 文字
    b.setFieldValue(b.fieldByIndex(1), seen + "AB");
    const d = dataOf(buildReadMdtResponse(b, codec, AID.ENTER, { row: 3, col: 10 }).record);
    // SO + 外字 + SI + "AB"（旧実装は `00 c1 c2`＝外字が生バイト 1 つに化けていた）
    expect(d.slice(6)).toEqual([0x0e, UDC_HI, UDC_LO, 0x0f, 0xc1, 0xc2]);
  });

  it("生バイトのセンチネルは従来どおり 1 バイトで戻る（退行防止）", () => {
    const b = screenWithUdc();
    b.setFieldValue(b.fieldByIndex(1), "A" + rawSentinel(0x1c) + "B");
    const d = dataOf(buildReadMdtResponse(b, codec, AID.ENTER, { row: 3, col: 10 }).record);
    expect(d.slice(6)).toEqual([0xc1, 0x1c, 0xc2]);
  });

  it("値は JSON で往復できる（単独サロゲートは `\\udcXX` へ逃げる）", () => {
    const v = "A" + rawSentinel(0x9f) + "B";
    const back = JSON.parse(JSON.stringify({ v })).v as string;
    expect(back).toBe(v);
    expect(sentinelByte([...back][1]!)).toBe(0x9f);
  });
});

/**
 * **DBCS 種別の申告が無い欄に SO/SI 入りのデータが載る場合**（日本語機の char 欄）。
 *
 * 値を 1 文字ずつの復号値で持つと、送信時に codec が SO/SI を付け直して**2 バイト増え**、
 * 欄長が固定なので末尾が落ちる。実機（`ASAOLIB/UDCPGM` の `IN2`）で、打鍵せず送り返すだけで
 * ホストが `DIFF` を返すことを確認した。門番は申告ではなく**中身**で決める。
 */
describe("申告の無い欄に載った DBCS データ", () => {
  /** SO + 「あい」(0x4481 0x4482) + SI + "AB" が SBCS 申告（FCW 無し）の欄に入っている */
  function sbcsFieldWithDbcs(): ScreenBuffer {
    const b = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20,
        ORDER.SBA, 3, 9, ORDER.SF, 0x40, 0x20, 0x20, 0x00, 0x0c,
        ORDER.SBA, 3, 10, 0x0e, 0x44, 0x81, 0x44, 0x82, 0x0f, 0xc1, 0xc2
      ]),
      b,
      codec,
      () => {}
    );
    return b;
  }
  const ORIGINAL = [0x0e, 0x44, 0x81, 0x44, 0x82, 0x0f, 0xc1, 0xc2];

  it("**触らず送り返せば原本のバイトのまま**（SO/SI が増えない）", () => {
    const b = sbcsFieldWithDbcs();
    b.setFieldValue(b.fieldByIndex(1), b.snapshot("s").fields[0]!.value);
    const d = dataOf(buildReadMdtResponse(b, codec, AID.ENTER, { row: 3, col: 10 }).record);
    expect(d.slice(6)).toEqual(ORIGINAL);
  });

  it("`dbcsContent` を立てて UI に「中身が DBCS」だと伝える（表示はセルから組み立てる）", () => {
    const f = sbcsFieldWithDbcs().snapshot("s").fields[0]!;
    expect(f.dbcsType).toBeUndefined(); // ホストの申告は SBCS のまま
    expect(f.dbcsContent).toBe(true);
  });

  it("SO/SI の無い普通の SBCS 欄には立てない（従来どおりの値）", () => {
    const b = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20,
        ORDER.SBA, 3, 9, ORDER.SF, 0x40, 0x20, 0x20, 0x00, 0x04,
        ORDER.SBA, 3, 10, 0xc1, 0xc2
      ]),
      b,
      codec,
      () => {}
    );
    const f = b.snapshot("s").fields[0]!;
    expect(f.dbcsContent).toBeUndefined();
    expect(f.value).toBe("AB");
  });
});
