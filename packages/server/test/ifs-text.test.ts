import { describe, it, expect } from "vitest";
import { decodeIfsText, encodeIfsText } from "../src/ifs-text.js";
import { encodeCcsidText } from "@as400web/core";

/**
 * 決定表（①手動 → ②BOM → ③UTF-8 → ④タグ）。
 *
 * **順序そのものが仕様**なので、順序を入れ替えると落ちるように書く。
 * とくに「UTF-8 の中身に 850 のタグ」（実機で普通に起きる。research F4）を
 * タグ優先で読むと化ける、という一点がこの決定表の存在理由。
 */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const ebcdic = (ccsid: number, s: string): Uint8Array => encodeCcsidText(ccsid, s).bytes;

describe("決定表", () => {
  it("中身が UTF-8 として読めれば、タグが違っていてもそれを採る", () => {
    // 実機の hello.txt と同じ状況: 中身 UTF-8 / タグ 850
    const r = decodeIfsText(utf8("日本語テスト@abc\n"), 850);
    expect(r).toEqual({
      ok: true,
      value: {
        content: "日本語テスト@abc\n",
        ccsid: 1208,
        detectedBy: "content",
        newline: "lf",
        bom: false
      }
    });
  });

  it("UTF-8 で読めなければタグに従う", () => {
    const r = decodeIfsText(ebcdic(1399, "日本語テスト@abc\n"), 1399);
    expect(r.ok && r.value.content).toBe("日本語テスト@abc\n");
    expect(r.ok && r.value.detectedBy).toBe("tag");
    expect(r.ok && r.value.ccsid).toBe(1399);
  });

  it("手動指定は推定より優先される", () => {
    // 中身は ASCII なので UTF-8 でも読めるが、利用者が 273 を選んだらそちらに従う
    const bytes = ebcdic(273, "Grüße@abc\n");
    expect(decodeIfsText(bytes, 1208, 273)).toMatchObject({
      ok: true,
      value: { content: "Grüße@abc\n", ccsid: 273, detectedBy: "manual" }
    });
  });

  it("BOM があれば UTF-8 判定より先に効く（bom を持ち回る）", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("abc")]);
    const r = decodeIfsText(withBom, 850);
    expect(r).toMatchObject({
      ok: true,
      value: { content: "abc", ccsid: 1208, detectedBy: "content", bom: true }
    });
  });

  it("UTF-16 の BOM（BE / LE）を見分ける", () => {
    const be = new Uint8Array([0xfe, 0xff, 0x30, 0x42]);
    const le = new Uint8Array([0xff, 0xfe, 0x42, 0x30]);
    expect(decodeIfsText(be, undefined)).toMatchObject({
      ok: true,
      value: { content: "あ", ccsid: 1200 }
    });
    expect(decodeIfsText(le, undefined)).toMatchObject({
      ok: true,
      value: { content: "あ", ccsid: 1202 }
    });
  });

  it("EBCDIC の 0x15 行末は \\n に直して nel と報告する", () => {
    const r = decodeIfsText(Uint8Array.from([0x81, 0x15, 0x82, 0x15]), 37);
    expect(r).toMatchObject({ ok: true, value: { content: "a\nb\n", newline: "nel" } });
  });

  it("タグが無い・0・65535・未対応なら、読めなければ諦める", () => {
    const bytes = ebcdic(37, "hello\n");
    for (const tag of [undefined, 0, 65535, 850]) {
      expect(decodeIfsText(bytes, tag)).toEqual({ ok: false, failure: "unsupported" });
    }
  });

  it("タグが中身と食い違って復号に失敗しても、例外にはしない", () => {
    // UTF-8 として読めないバイト列に、UTF-8 のタグが付いている
    const bytes = Uint8Array.from([0xc1, 0xc2, 0xc3]);
    expect(decodeIfsText(bytes, 1208)).toEqual({ ok: false, failure: "unsupported" });
  });

  it("手動指定が未対応・復号不能ならそれぞれの理由を返す", () => {
    expect(decodeIfsText(utf8("a"), undefined, 850)).toEqual({
      ok: false,
      failure: "manual-unsupported"
    });
    expect(decodeIfsText(Uint8Array.from([0xc1]), undefined, 1208)).toEqual({
      ok: false,
      failure: "manual-failed"
    });
  });

  it("空のファイルは UTF-8 の空文字列として読める", () => {
    expect(decodeIfsText(new Uint8Array(0), 850)).toMatchObject({
      ok: true,
      value: { content: "", ccsid: 1208 }
    });
  });
});

describe("保存（符号化）", () => {
  it("読んだときの ccsid / newline / bom で往復する", () => {
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("あa\n")]);
    const read = decodeIfsText(original, 1208);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const written = encodeIfsText(read.value.ccsid, read.value.content, {
      newline: read.value.newline,
      bom: read.value.bom
    });
    expect(written.ok && [...written.bytes]).toEqual([...original]);
  });

  it("EBCDIC の nel も往復する", () => {
    const original = Uint8Array.from([0x81, 0x15, 0x82, 0x15]);
    const read = decodeIfsText(original, 37);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const written = encodeIfsText(37, read.value.content, { newline: read.value.newline });
    expect(written.ok && [...written.bytes]).toEqual([...original]);
  });

  it("マップ不能な文字は件数を返す（保存は止めない）", () => {
    const r = encodeIfsText(819, "A日");
    expect(r).toMatchObject({ ok: true, substituted: 1 });
  });

  it("符号化できない文字コードは書く前に断る", () => {
    expect(encodeIfsText(943, "あ")).toEqual({ ok: false, failure: "unsupported" });
  });
});
