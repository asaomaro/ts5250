import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { COMMAND, ESC, ORDER } from "../src/protocol/constants.js";

/**
 * 非表示属性の欄は `hidden` にならなければならない。
 *
 * SEU の F1 ヘルプで、フィールドは `hidden: false` なのにセルは `nonDisplay: true` という
 * 食い違いが出た。UI は `hidden` を見て伏せ字にするため、非表示欄に打った文字が
 * そのまま見えていた（実機で `#` が表示された）。
 *
 * 表示を決めるのは**画面上の実効属性**であって、SF 記録時の属性バイトではない。
 */
const codec = codecForCcsid(37);

describe("非表示属性のフィールド", () => {
  it("SF の属性バイトが非表示なら hidden になる", () => {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 2, 1,
        // SF FFW=0x4000 属性=0x27（緑・非表示） 長さ=1
        ORDER.SF, 0x40, 0x00, 0x27, 0x00, 0x01,
        0x7b // '#'
      ]),
      buf,
      codec,
      () => {}
    );
    const snap = buf.snapshot("s", false);
    expect(snap.fields[0]!.hidden, "非表示属性の欄が hidden になっていない").toBe(true);
    expect(snap.fields[0]!.value, "非表示欄の平文が value に載っている").toBe("");
    expect(snap.cells[1]![1]!.char, "非表示欄の文字が描画されている").toBe(" ");
  });

  it("あとから非表示属性で上書きされた欄も hidden になる", () => {
    // SF 時は通常属性（0x20）。その後に同じ桁へ非表示属性（0x27）を書き込む。
    // attrByte だけを見ていると取りこぼす経路。
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        ORDER.SBA, 2, 1,
        ORDER.SF, 0x40, 0x00, 0x20, 0x00, 0x01,
        0x7b,
        ORDER.SBA, 2, 1,
        0x27 // 属性桁を非表示へ上書き
      ]),
      buf,
      codec,
      () => {}
    );
    const snap = buf.snapshot("s", false);
    expect(snap.cells[1]![1]!.nonDisplay, "セルが非表示になっていない").toBe(true);
    expect(snap.fields[0]!.hidden, "セルは非表示なのに hidden が false").toBe(true);
    expect(snap.fields[0]!.value).toBe("");
  });
});
