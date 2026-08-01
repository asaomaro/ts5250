import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { codecForCcsid } from "@as400web/ebcdic/codec";
import { COMMAND, ESC } from "../src/protocol/constants.js";

/**
 * ROLL（ESC 0x23）＝表示イメージの行送り。
 *
 * ⚠ **実機では未確認**（11 画面の国勢調査で 1 件も届かなかった。
 * `20260730-datastream-command-census`）。根拠は**原典 2 実装の一致**:
 *
 * - tn5250 `session.c`: `0x80` が落ちていれば行数を負にし、`dbuffer.c` は負を "Move text up"
 * - tn5250j `Screen5250.rollScreen`: コメント「0 - up / 1 - down」
 *
 * → **`0x80` 落ち＝上へ / 立ち＝下へ**（当方は最初これを逆に実装していた。
 * `20260730-tn5250-cross-check` research F1）。
 * 行数は下位 5 ビット（tn5250 と同じ。tn5250j は `& 0x7f` だが 32 以上は画面を超えるので差が出ない）。
 */
const codec = codecForCcsid(37);

/** 各行の先頭 1 文字に A, B, C… を書いた画面を作る */
function laddered(rows = 6): ScreenBuffer {
  const buf = new ScreenBuffer();
  const stream: number[] = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00];
  for (let r = 1; r <= rows; r++) stream.push(0x11, r, 0x01, 0xc0 + r); // SBA(r,1) ＋ EBCDIC の A..
  applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
  return buf;
}

const heads = (buf: ScreenBuffer, n = 6): string =>
  buf
    .snapshot()
    .cells.slice(0, n)
    .map((row) => row[0]!.char)
    .join("");

describe("roll", () => {
  it("上へ 1 行送る（下端に空行ができる）", () => {
    const buf = laddered();
    buf.roll(1, 6, 1);
    expect(heads(buf)).toBe("BCDEF ");
  });

  it("下へ 1 行送る（上端に空行ができる）", () => {
    const buf = laddered();
    buf.roll(1, 6, -1);
    expect(heads(buf)).toBe(" ABCDE");
  });

  it("範囲を限って送る（範囲の外は動かない）", () => {
    const buf = laddered();
    buf.roll(2, 4, 1); // B C D → C D 空
    expect(heads(buf)).toBe("ACD EF");
  });

  it("複数行の送りもできる", () => {
    const buf = laddered();
    buf.roll(1, 6, 2);
    expect(heads(buf)).toBe("CDEF  ");
  });

  it("0 行の指定は何もしない", () => {
    const buf = laddered();
    buf.roll(1, 6, 0);
    expect(heads(buf)).toBe("ABCDEF");
  });

  it("範囲が逆・1 行だけの指定は何もしない", () => {
    const buf = laddered();
    buf.roll(4, 2, 1);
    buf.roll(3, 3, 1);
    expect(heads(buf)).toBe("ABCDEF");
  });

  it("範囲を超える送りは範囲を空にする", () => {
    const buf = laddered();
    buf.roll(1, 3, 5);
    expect(heads(buf)).toBe("   DEF");
  });

  it("**フィールド定義は動かさない**（入力欄の位置がずれないように）", () => {
    const buf = new ScreenBuffer();
    // 3 行目に入力フィールドを 1 つ置く
    applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        0x11, 0x03, 0x01, // SBA(3,1)
        0x1d, 0x40, 0x00, 0x20, 0x00, 0x05 // SF: FFW, 属性, 長さ 5
      ]),
      buf,
      codec,
      () => {}
    );
    const before = buf.snapshot().fields.map((f) => `${f.row},${f.col},${f.length}`);
    buf.roll(1, 10, 1);
    expect(buf.snapshot().fields.map((f) => `${f.row},${f.col},${f.length}`)).toEqual(before);
  });
});

describe("ESC 0x23 の解釈", () => {
  function rollStream(dir: number, top: number, bottom: number): number[] {
    return [ESC, COMMAND.ROLL, dir, top, bottom];
  }

  it("**上位ビットが落ちていれば上へ**送る（原典 2 実装の一致）", () => {
    const buf = laddered();
    applyDataStream(Uint8Array.from(rollStream(0x01, 1, 6)), buf, codec, () => {});
    expect(heads(buf)).toBe("BCDEF ");
  });

  it("**上位ビットが立っていれば下へ**送る", () => {
    const buf = laddered();
    applyDataStream(Uint8Array.from(rollStream(0x81, 1, 6)), buf, codec, () => {});
    expect(heads(buf)).toBe(" ABCDE");
  });

  it("行数は下位 5 ビット", () => {
    const buf = laddered();
    applyDataStream(Uint8Array.from(rollStream(0x02, 1, 6)), buf, codec, () => {});
    expect(heads(buf)).toBe("CDEF  ");
  });

  it("**パラメータ 3 バイトを消費し、後続のコマンドを捨てない**", () => {
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    const result = applyDataStream(
      Uint8Array.from([...rollStream(0x01, 1, 6), ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
    expect(result.readRequested).toBe(true);
    expect(result.unlockKeyboard).toBe(true);
  });
});
