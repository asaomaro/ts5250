import { describe, it, expect } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import {
  renderFrame, TerminalController, DEFAULT_VIEW, toggleView, resolveSbcsView, recodeByte, cursorSequence, headerText
} from "../src/index.js";
import { sessionFrom, plain } from "./helpers.js";

const VP = { cols: 80, rows: 26 };

async function blank(): Promise<ScreenSnapshot> {
  const snap = (await sessionFrom("pub400-jobinfo")).snapshot();
  const cells = snap.cells.map((r) => r.map((c) => ({ ...c, kind: "sbcs" as const, char: " ", underline: false, columnSeparator: false })));
  return { ...snap, cells };
}

const box = (snap: ScreenSnapshot): ScreenSnapshot => ({
  ...snap,
  gui: {
    selectionFields: [], windows: [], scrollBars: [],
    gridLines: [{ id: 1, minorType: 0x04, row: 3, col: 5, width: 6, height: 3, lineStyle: 0, color: 0x01, value1: 0, value2: 0 }]
  }
});

describe("画面表示の設定", () => {
  it("罫線を切ると罫線文字が出ない", async () => {
    const snap = box(await blank());
    const on = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false } });
    const off = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false, grid: false } });
    expect(plain(on.rows[2]!)).toContain("┌────┐");
    expect(plain(off.rows[2]!)).not.toContain("┌");
  });

  it("文字のあるセルの横罫は上線・下線で重ね、文字は消えない", async () => {
    const snap = box(await blank());
    snap.cells[2]![6] = { ...snap.cells[2]![6]!, char: "X" };
    snap.cells[4]![6] = { ...snap.cells[4]![6]!, char: "Y" };
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false } });
    // 文字のある行では横罫を罫線文字にせず、空白のセルにも上線を引く（文字と同じ行の中ほどに線を走らせない）
    expect(plain(f.rows[2]!).slice(4, 10)).toBe("┌ X  ┐");
    expect(f.rows[2]!).toMatch(/;53m X  \x1b/);
    expect(f.rows[4]!).toMatch(/;4m[^\x1b]*Y/);
  });

  it("SO/SI は設定に応じて { } を出す（薄目は淡色）", async () => {
    const snap = await blank();
    snap.cells[0]![0] = { ...snap.cells[0]![0]!, kind: "so", char: "" };
    snap.cells[0]![1] = { ...snap.cells[0]![1]!, kind: "si", char: "" };
    const none = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false } });
    const dim = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false, sosi: "dim" } });
    const strong = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false, sosi: "strong" } });
    expect(plain(none.rows[0]!).slice(0, 2)).toBe("  ");
    expect(plain(dim.rows[0]!).slice(0, 2)).toBe("{}");
    expect(dim.rows[0]!).toMatch(/;2m\{\}/);
    expect(plain(strong.rows[0]!).slice(0, 2)).toBe("{}");
    expect(strong.rows[0]!).not.toMatch(/;2m\{\}/);
  });

  it("表示コードの切替は生バイトを対の表で読み直す", async () => {
    const snap = await blank();
    snap.cells[0]![0] = { ...snap.cells[0]![0]!, char: "x", rawByte: 0x81 };
    const view = { ...DEFAULT_VIEW, header: false, kana: "kana" as const };
    const f = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view, hostKatakana: false });
    expect(plain(f.rows[0]!).startsWith("ｱ")).toBe(true);
    // ホストの表と同じ向きなら読み直さない
    const g = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view, hostKatakana: true });
    expect(plain(g.rows[0]!).startsWith("x")).toBe(true);
    expect(resolveSbcsView("latin", true)).toBe("latin");
    expect(recodeByte(0x00, "kana")).toBe(" ");
  });

  it("ルーラーはカーソルの行と桁を帯にする（横・縦・十字）", async () => {
    const snap = await blank();
    const tint = "48;2;40;48;72";
    const at = { row: 5, col: 10 };
    const base = { viewport: VP, colorMode: "truecolor" as const, ruleAt: at };
    const cross = renderFrame(snap, { ...base, view: { ...DEFAULT_VIEW, header: false, rule: true } });
    expect(cross.rows[4]!).toContain(tint);
    expect(cross.rows[0]!).toContain(tint); // 桁の帯は全行を通る
    const h = renderFrame(snap, { ...base, view: { ...DEFAULT_VIEW, header: false, rule: true, ruleStyle: "horizontal" } });
    expect(h.rows[4]!).toContain(tint);
    expect(h.rows[0]!).not.toContain(tint);
    const off = renderFrame(snap, { ...base, view: { ...DEFAULT_VIEW, header: false } });
    expect(off.rows.join("")).not.toContain(tint);
  });

  it("ヘッダーは 1 行足して画面を 1 行下げ、足りなければ出さない", async () => {
    const snap = await blank();
    const withHeader = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: DEFAULT_VIEW, cursor: { row: 2, col: 3 } });
    expect(plain(withHeader.rows[0]!)).toContain("罫線:入");
    expect(withHeader.rows.length).toBe(snap.rows + 2);
    expect(withHeader.cursor).toEqual({ row: 3, col: 3 });
    const tight = renderFrame(snap, { viewport: { cols: 80, rows: snap.rows + 1 }, colorMode: "truecolor", view: DEFAULT_VIEW });
    expect(tight.rows.length).toBe(snap.rows + 1);
    expect(plain(tight.rows[0]!)).not.toContain("罫線:");
  });

  it("桁区切りを切ると点線の下線を出さない", async () => {
    const snap = await blank();
    snap.cells[0]![0] = { ...snap.cells[0]![0]!, columnSeparator: true };
    const on = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false } });
    const off = renderFrame(snap, { viewport: VP, colorMode: "truecolor", view: { ...DEFAULT_VIEW, header: false, colSep: false } });
    expect(on.rows[0]!).toContain("4:4");
    expect(off.rows[0]!).not.toContain("4:4");
  });

  it("カーソルの形（DECSCUSR）。挿入中は下線", () => {
    expect(cursorSequence({ ...DEFAULT_VIEW, cursorShape: "block", cursorBlink: true }, false)).toBe("\x1b[1 q");
    expect(cursorSequence({ ...DEFAULT_VIEW, cursorShape: "block", cursorBlink: false }, false)).toBe("\x1b[2 q");
    expect(cursorSequence({ ...DEFAULT_VIEW, cursorShape: "underline", cursorBlink: true }, false)).toBe("\x1b[3 q");
    expect(cursorSequence({ ...DEFAULT_VIEW, cursorShape: "block", cursorBlink: false }, true)).toBe("\x1b[4 q");
  });

  it("接頭キーの次の文字で切り替わり、ヘッダーに現在値が出る", async () => {
    const session = await sessionFrom("pub400-jobinfo");
    const ctl = new TerminalController(session);
    const press = async (ch: string): Promise<void> => {
      await ctl.handle({ kind: "char", ch: "]", ctrl: true, alt: false, shift: false });
      await ctl.handle({ kind: "char", ch, ctrl: false, alt: false, shift: false });
    };
    await press("g");
    expect(ctl.view.grid).toBe(false);
    await press("o");
    expect(ctl.view.sosi).toBe("dim");
    await press("k");
    expect(ctl.view.kana).toBe("kana");
    await press("l");
    expect(ctl.view.rule).toBe(true);
    // 固定にすると、そのときのカーソルを保つ
    const at = { ...ctl.cursor };
    await press("f");
    await ctl.handle({ kind: "key", name: "Right", ctrl: false, alt: false, shift: false });
    expect(ctl.ruleAt()).toEqual(at);
    await press("f");
    expect(ctl.ruleAt()).toEqual(ctl.cursor);
    expect(headerText(ctl.view, "]")).toContain("罫線:切");
    expect(toggleView(DEFAULT_VIEW, "?")).toBeNull();
  });
});
