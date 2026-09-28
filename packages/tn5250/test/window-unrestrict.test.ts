import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * **窓のカーソル制限の解除（WDSF 0x52）**（`20260928-window-unrestrict`。ACS `ENPTUI5250.unrestrictWindowCursor`）。
 * 実機の ACS のコア（DSM の WINRESTRICT / WINUNRESTRICT / WINUNRESTRICTBAD・`scripts/acs-probe/window-unrestrict.txt`。ENPTUI を申告）:
 * 制限つきの窓では矢印が窓の中を回り、0x52（中身 2 バイト）の後は窓の外へ出た。中身 3 バイトは否定応答（ホストの次の読みが CPFA304）
 */
const codec = codecForCcsid(930);

/** DSM の WINRESTRICT と同じ窓（(5,10)・深さ 5・幅 20・flag1 0x80＝カーソルを制限） */
const WINDOW = [ORDER.SBA, 5, 10, 0x15, 0x00, 0x0e, 0xd9, 0x51, 0x80, 0x00, 0x00, 0x05, 0x14, 0x05, 0x01, 0x80, 0x38, 0x38];
const unrestrict = (body: number[]): number[] => [0x15, 0x00, 4 + body.length, 0xd9, 0x52, ...body];

function run(...wtds: number[][]): { buf: ScreenBuffer; senses: (number | undefined)[] } {
  const buf = new ScreenBuffer();
  const senses = wtds.map((w) => applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...w]), buf, codec, () => {}).senseCode);
  return { buf, senses };
}
const restricted = (buf: ScreenBuffer): boolean[] => (buf.snapshot("s", false).gui?.windows ?? []).map((w) => w.restrictCursor);
const current = (buf: ScreenBuffer): (boolean | undefined)[] => (buf.snapshot("s", false).gui?.windows ?? []).map((w) => w.current);

describe("WDSF 0x52（窓のカーソル制限の解除）", () => {
  it("**中身 2 バイトなら直近の窓の制限を外す**（別のレコードでも）", () => {
    const { buf, senses } = run(WINDOW, unrestrict([0x00, 0x00]));
    expect(senses).toEqual([undefined, undefined]);
    expect(restricted(buf)).toEqual([false]);
  });

  it("0x52 が無ければ制限つきのまま（対照）", () => {
    expect(restricted(run(WINDOW).buf)).toEqual([true]);
  });

  it.each([[[0x00]], [[0x00, 0x00, 0x00]], [[]]])("**中身が 2 バイトでなければ否定応答 0x10050110**・制限は残る（中身 %j）", (body) => {
    const { buf, senses } = run(WINDOW, unrestrict(body));
    expect(senses[1]).toBe(0x10050110);
    expect(restricted(buf)).toEqual([true]);
  });

  it("**直近の窓だけ**（2 つ目の窓の制限を外し、1 つ目は印が残る。閉じ込めを見るのは直近の窓だけ——画面の写しの `current`）", () => {
    const second = [ORDER.SBA, 12, 10, 0x15, 0x00, 0x0e, 0xd9, 0x51, 0x80, 0x00, 0x00, 0x03, 0x10, 0x05, 0x01, 0x80, 0x38, 0x38];
    const { buf } = run(WINDOW, second, unrestrict([0x00, 0x00]));
    expect(restricted(buf)).toEqual([true, false]);
    expect(current(buf)).toEqual([undefined, true]);
  });

  it("**SOH の CSRINPONLY（0x10）も直近の窓の制限を外す**（ACS `setCursorMoveToInput(true)` → `unrestrictWindowCursor`）", () => {
    const soh = [ORDER.SOH, 0x01, 0x10];
    expect(restricted(run(WINDOW, soh).buf)).toEqual([false]);
    expect(restricted(run(WINDOW, [ORDER.SOH, 0x01, 0x00]).buf)).toEqual([true]);
  });

  it("**最後に作った窓を消した後は、前の窓の制限を外さない**（ACS は `enpwindow` を null にする）", () => {
    const second = [ORDER.SBA, 12, 10, 0x15, 0x00, 0x0e, 0xd9, 0x51, 0x80, 0x00, 0x00, 0x03, 0x10, 0x05, 0x01, 0x80, 0x38, 0x38];
    // REMOVE GUI WINDOW（0x59）で (12,10) の窓を消す
    const removeSecond = [ORDER.SBA, 12, 10, 0x15, 0x00, 0x07, 0xd9, 0x59, 0x00, 0x00, 0x00];
    expect(restricted(run(WINDOW, second, removeSecond, unrestrict([0x00, 0x00])).buf)).toEqual([true]);
  });

  it("退避と復元で「最後に作った窓」も戻る", () => {
    const { buf } = run(WINDOW);
    buf.saveScreen();
    buf.clearUnit();
    buf.restoreScreen();
    applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...unrestrict([0x00, 0x00])]), buf, codec, () => {});
    expect(restricted(buf)).toEqual([false]);
  });

  it("窓が無ければ何もしない（否定応答もしない）", () => {
    expect(run(unrestrict([0x00, 0x00])).senses).toEqual([undefined]);
  });
});
