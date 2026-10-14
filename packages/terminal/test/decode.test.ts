import { describe, it, expect } from "vitest";
import { KeyDecoder } from "../src/index.js";

const dec = (s: string) => new KeyDecoder().feed(s);

describe("KeyDecoder（tmux 3.4 で実測した列）", () => {
  it.each([
    ["\x1bOP", "F1", false],
    ["\x1b[15~", "F5", false],
    ["\x1b[24~", "F12", false],
    ["\x1b[1;2P", "F1", true],
    ["\x1b[24;2~", "F12", true],
    ["\x1b[5~", "PageUp", false],
    ["\x1b[6~", "PageDown", false],
    ["\x1b[1~", "Home", false],
    ["\x1b[H", "Home", false],
    ["\x1b[4~", "End", false],
    ["\x1b[2~", "Insert", false],
    ["\x1b[3~", "Delete", false],
    ["\x1b[A", "Up", false],
    ["\x1b[1;5D", "Left", false],
    ["\x1b[Z", "BackTab", true]
  ] as const)("%j → %s", (seq, name, shift) => {
    const [e] = dec(seq);
    expect(e).toMatchObject({ kind: "key", name, shift });
  });

  it("Ctrl+矢印は ctrl", () => {
    expect(dec("\x1b[1;5C")[0]).toMatchObject({ name: "Right", ctrl: true });
  });
  it("Enter・Tab・Backspace", () => {
    expect(dec("\r")[0]).toMatchObject({ name: "Enter" });
    expect(dec("\t")[0]).toMatchObject({ name: "Tab" });
    expect(dec("\x7f")[0]).toMatchObject({ name: "Backspace" });
  });
  it("Ctrl+] は接頭キー（0x1d）", () => {
    expect(dec("\x1d")[0]).toEqual({ kind: "char", ch: "]", ctrl: true, alt: false });
  });
  it("一度に届いた複数の打鍵（日本語・半角カナを含む）を分ける", () => {
    const e = dec("A日ｱ");
    expect(e.map((x) => (x.kind === "char" ? x.ch : "?"))).toEqual(["A", "日", "ｱ"]);
  });
  it("割れて届いた列を持ち越す", () => {
    const d = new KeyDecoder();
    expect(d.feed("\x1b[1")).toEqual([]);
    expect(d.feed("5~")[0]).toMatchObject({ name: "F5" });
  });
  it("ESC 単独は flush で確定する", () => {
    const d = new KeyDecoder();
    expect(d.feed("\x1b")).toEqual([]);
    expect(d.flush()[0]).toMatchObject({ name: "Escape" });
  });
  it("括弧付きペーストを文字列として受ける（改行は空白）", () => {
    const e = dec("\x1b[200~ab\ncd\x1b[201~");
    expect(e.map((x) => (x.kind === "char" ? x.ch : "?")).join("")).toBe("ab cd");
  });
  it("未知の CSI（マウス・応答）は黙って捨てる", () => {
    expect(dec("\x1b[<0;10;5M")).toEqual([]);
  });
});
