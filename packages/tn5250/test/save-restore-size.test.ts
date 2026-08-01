import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";

/**
 * SAVE / RESTORE SCREEN は**サイズも往復させる**。
 *
 * SEU で F1（ヘルプ）→ F12（戻る）を踏むと画面が崩れた。ヘルプ側が CLEAR UNIT で
 * 24x80 に落とし、F12 の RESTORE SCREEN が 27x132 の cells だけ戻していたため、
 * cells.length（3564）と rows*cols（1920）が食い違い、描画が 80 桁で折り返していた。
 */
describe("SAVE/RESTORE SCREEN のサイズ往復", () => {
  it("27x132 を退避し 24x80 へクリアしたあと復元すると 27x132 に戻る", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    expect(buf.clearUnitAlternate()).toBe(true);
    buf.setChar(buf.addrOf(27, 132), "X");

    buf.saveScreen();
    buf.clearUnit(); // ヘルプ画面が 24x80 に切替える
    expect(buf.rows).toBe(24);
    expect(buf.cols).toBe(80);

    expect(buf.restoreScreen()).toBe(true);
    expect(buf.rows).toBe(27);
    expect(buf.cols).toBe(132);

    // 復元後もセル配列とサイズが整合していること（崩れの直接原因はここの不一致）
    const snap = buf.snapshot("s", false);
    expect(snap.cells).toHaveLength(27);
    expect(snap.cells[0]).toHaveLength(132);
    expect(snap.cells[26]![131]!.char).toBe("X");
  });
});
