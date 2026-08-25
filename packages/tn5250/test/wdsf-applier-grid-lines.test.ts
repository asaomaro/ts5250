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

  /**
   * **S9R167D（`DSPSIZ(24 80 *DS3)`＝alternate 未申告）の再発。**
   *
   * KSN20 は多くの画面で共有される罫線レコードで、alternate（27x132）を申告した
   * 画面（YB0270R）向けの修正だけでは、alternate を申告していない 24x80 専用の画面で
   * 同じ CLEAR UNIT ALTERNATE が来たときに再び罫線が消える。`clearUnitAlternate()` が
   * 未許可なら呼び出し側が `clearUnit()`（`clearGui()` 呼び出し＝GUI 構造体を丸ごと消す）へ
   * フォールバックしていたため。alternate 未申告の端末でも GUI 構造体を残したままクリアする。
   */
  it("alternate 未申告（24x80 専用）の端末でも罫線を描いた直後の CLEAR UNIT ALTERNATE で罫線が消えない", () => {
    const buf = new ScreenBuffer();
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
});

/**
 * **S9R167D の実機トレースで確定した本当の原因（`--trace-records` で採取・本 PJ の実機）。**
 *
 * 上の 2 件（CLEAR UNIT ALTERNATE 経路）を直しても症状は再現し続けた。実機トレースを
 * 1 レコードずつ再生すると、S9R167D の画面を組む**同じレコードの中**で
 * 「KSN20 の罫線（13 本）を描く → 直後に素の CLEAR UNIT（ESC 0x40。ALTERNATE ではない）」
 * という順で来ていた。`clearUnit()` は `clearGui()` を呼んでおり、これが窓だけでなく
 * 罫線まで一緒に消していたため、最終的に画面には罫線が 1 本も残らなかった
 * （ACS は罫線を表示し続ける＝実機は罫線を消していない）。
 *
 * 罫線には Clear Grid Line Buffer（0x61）という専用の消去コマンドが別にあることから、
 * CLEAR UNIT による窓の暗黙クローズ（`closeWindowsAndSelections()`）とは寿命管理が
 * 別物と判断した。
 */
describe("CLEAR UNIT と罫線・窓の共存（S9R167D 実機トレース）", () => {
  it("罫線を描いた直後の素の CLEAR UNIT で罫線が消えない", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [...writeToDisplay(wdsf(0x60, gridDrawBody)), ESC, COMMAND.CLEAR_UNIT];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    const gui = buf.snapshot("t", false).gui;
    expect(gui?.gridLines).toHaveLength(1);
    expect(gui!.gridLines[0]).toMatchObject({ minorType: 0x02, row: 5, col: 2, height: 20 });
  });

  it("それでも CLEAR UNIT は窓を暗黙に閉じる（既存の窓クローズ挙動は維持）", () => {
    const buf = new ScreenBuffer();
    // CREATE WINDOW（最小: flag1＋予約2＋高さ＋幅）を窓として登録してから CLEAR UNIT
    const createWindow = wdsf(0x51, [0x00, 0x00, 0x00, 6, 30]);
    const stream = [...writeToDisplay(createWindow), ESC, COMMAND.CLEAR_UNIT];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });

  it("REM_ALL_GUI_CONSTRUCTS は罫線も窓も両方消す（専用コマンドは変わらず効く）", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [...writeToDisplay(wdsf(0x60, gridDrawBody)), ...writeToDisplay(wdsf(0x5f, [0x00]))];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });
});

/**
 * **CLEAR UNIT ALTERNATE も窓は閉じる（2026-08-25・実機で再現した残骸）。**
 *
 * ~~CUA では GUI 構造体を一切消さない~~ ← **窓を残すと画面に残骸が出る。**
 *
 * 罫線を守るために窓まで残していたのは `closeWindowsAndSelections()`（罫線を対象外にする）が
 * まだ無かった頃の名残で、`20260728-datastream-gui-bugfixes` で観測されたのは
 * **罫線が消える症状だけ**。窓まで残す必要は一度も観測されていない。
 *
 * 実機で確かめた（`scripts/host-src/dscmd.c` の `WINCUA`。DSM に背景 → CREATE WINDOW →
 * CLEAR UNIT ALTERNATE を順に出させる）:
 *
 * ```
 * 受信 04 11 00 00 11 05 0a 15 00 16 d9 51 …   ← 窓 (5,10) 20x5 見出し "WN"
 * 受信 04 20 00                                 ← CLEAR UNIT ALTERNATE
 * 受信 04 11 00 00 11 02 02 …AFTER CUA…         ← ホストは画面を作り直している
 * gui.windows = [{ row: 5, col: 10, width: 20, height: 5, title: "WN" }]  ← **残ったまま**
 * ```
 *
 * 参照実装 2 つ（tn5250 `dbuffer.c` / tn5250j `Screen5250`）も CUA で窓を閉じる。
 */
describe("CLEAR UNIT ALTERNATE と窓（実機 WINCUA）", () => {
  /** 実機で出させたのと同じ CREATE WINDOW（境界＋見出し "WN"） */
  const createWindow = wdsf(0x51, [
    0x00, 0x00, 0x00, 0x05, 0x14,
    0x05, 0x01, 0x80, 0x38, 0x38,
    0x08, 0x10, 0x00, 0x00, 0x00, 0x00, 0xe6, 0xd5
  ]);

  it("窓は閉じる（残すと画面に残骸が出る。実機で再現）", () => {
    const buf = new ScreenBuffer();
    const stream = [
      ...writeToDisplay([ORDER.SBA, 5, 10, ...createWindow]),
      ESC,
      COMMAND.CLEAR_UNIT_ALTERNATE,
      0x00
    ];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui?.windows ?? []).toEqual([]);
  });

  it("**罫線は巻き添えにしない**（窓を閉じても罫線は残る＝KSN20 の回帰）", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [
      ...writeToDisplay([...wdsf(0x60, gridDrawBody), ORDER.SBA, 5, 10, ...createWindow]),
      ESC,
      COMMAND.CLEAR_UNIT_ALTERNATE,
      0x00
    ];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    const gui = buf.snapshot("t", false).gui;
    expect(gui?.gridLines).toHaveLength(1);
    expect(gui?.windows ?? []).toEqual([]);
  });
});
