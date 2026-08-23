import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic";

const codec = codecForCcsid(930);

/** WDSF 構造体（class 0xD9 + type + body）を WTD オーダーとして包む */
function wdsf(type: number, body: number[]): number[] {
  const sf = [0xd9, type, ...body];
  const ll = sf.length + 2; // LL は自身 2 バイトを含む
  return [ORDER.WDSF, (ll >> 8) & 0xff, ll & 0xff, ...sf];
}

/** グリッド線 1 本（GRDLIN 単独罫線・LEFT）の Draw/Erase Grid Lines 主構造＋マイナー構造 */
const gridDrawBody = [
  0x01,
  0x20,
  0x00,
  0x20,
  0x00,
  0x0f, // defaultColor（GRDATR((*COLOR HWHT))）
  0x00, // defaultLine
  0x0b,
  0x02,
  0x00,
  0x05,
  0x02,
  0x00,
  0x14,
  0xff,
  0xff,
  0x01,
  0x01 // GRDLIN((*POS (5 2 20)) (*TYPE LEFT))
];

function writeToDisplay(orders: number[]): number[] {
  return [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20, ...orders];
}

/**
 * **KSN00/KSN20（YB0200RD・YB0270RD）の罫線が全く表示されない不具合の再現テスト。**
 *
 * 実機のトレースで、`WRITE KSN20`（罫線を描く）の直後に
 * **CLEAR UNIT ALTERNATE が送られてくる**ことを確認した。SFLCTL(SFLDSPCTL) を持つ
 * 画面（YB0270R）の 1 回の画面構築の中で何度も現れる、ごく普通の 5250 データストリーム。
 *
 * ところが `ScreenBuffer.clearUnitAlternate()`（→ `resize()`）は常に `clearGui()` を
 * 呼んでおり、既に描いたばかりの罫線を含む GUI 構造体を丸ごと消していた。
 * ホストは画面を切り替えるときは REM_ALL_GUI_CONSTRUCTS 等を明示的に送ってくる
 * （同じトレースで確認）ので、CLEAR UNIT ALTERNATE 側で GUI を消す必要はない。
 */
describe("CLEAR UNIT ALTERNATE と罫線の共存", () => {
  it("罫線を描いた直後の CLEAR UNIT ALTERNATE で罫線が消えない", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [
      ...writeToDisplay(wdsf(0x60, gridDrawBody)),
      ESC,
      COMMAND.CLEAR_UNIT_ALTERNATE,
      0x00
    ];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    const gui = buf.snapshot("t", false).gui;
    expect(gui?.gridLines).toHaveLength(1);
    expect(gui!.gridLines[0]).toMatchObject({ minorType: 0x02, row: 5, col: 2, height: 20 });
  });

  it("REM_ALL_GUI_CONSTRUCTS では引き続き罫線が消える（専用コマンドは効く）", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [
      ...writeToDisplay(wdsf(0x60, gridDrawBody)),
      ...writeToDisplay(wdsf(0x5f, [0x00]))
    ];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });
});
