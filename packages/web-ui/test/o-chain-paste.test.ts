import { describe, it, expect } from "vitest";
import { chainPaste } from "../src/composables/oChainCells.js";
import { nulCell, type OCell } from "../src/composables/oFieldCells.js";

/**
 * **継続した O 欄への貼り付け**（`20260930-cont-o-edge`）。期待値は実機の ACS のコア（`ECLPS.pasteLineWrap`。DSM の CONTOP・`scripts/acs-probe/cont-o-paste.txt` の P1〜P4）が
 * ホストへ送ったバイト列を、区間ごとのセルの記法に直したもの（`o-chain-cells.test.ts` と同じ。`<` = SO、`>` = SI、`_` = 空き、`~` = 死んだ桁、全角は字）。鎖は 8 桁の空の区間が 3 つ
 */
const seg = (spec: string): OCell[] => {
  const out: OCell[] = [];
  for (const ch of spec) {
    if (ch === "<") out.push({ k: "so", ch: "" });
    else if (ch === ">") out.push({ k: "si", ch: "" });
    else if (ch === "_") out.push(nulCell());
    else if (ch === "~") out.push({ k: "sb", ch: " ", dead: true });
    else if (/[　-鿿]/.test(ch)) out.push({ k: "lead", ch }, { k: "tail", ch: "" });
    else out.push({ k: "sb", ch });
  }
  while (out.length < 8) out.push(nulCell());
  return out;
};
const show = (cells: readonly OCell[]): string => {
  let s = "";
  for (const c of cells) s += c.k === "so" ? "<" : c.k === "si" ? ">" : c.k === "tail" ? "" : c.dead ? "~" : c.nul ? "_" : c.ch;
  return s;
};
const empty = (): OCell[][] => [seg(""), seg(""), seg("")];
const run = (chars: string, seg0 = 0, c = 0, insert = false) => {
  const r = chainPaste(empty(), { seg: seg0, c }, [...chars], insert);
  return { segs: r.segs.map(show), cursor: r.cursor, placed: r.placed, error: r.error };
};

describe("継続した O 欄への貼り付け（ACS の P1〜P4）", () => {
  it("P1: 全角 8 字は最初の区間の 3 字（SO あいう SI）で止まる", () => {
    expect(run("あいうえおかきく")).toEqual({ segs: ["<あいう>", "________", "________"], cursor: { seg: 0, c: 0 }, placed: 3, error: undefined });
  });
  it("P2: 半角 16 字は最初の区間の 8 字で止まる", () => {
    expect(run("ABCDEFGHIJKLMNOP")).toMatchObject({ segs: ["ABCDEFGH", "________", "________"], placed: 8 });
  });
  it("P3: 全角が区間の残りに入らなければ、次の区間の頭へ置いてから止まる（カーソルが区間を出た字で止まる）", () => {
    const r = run("AあBいCう");
    expect(r.segs).toEqual(["A<あ>B_~", "<い>____", "________"]);
    expect(r.placed).toBe(4);
  });
  it("P4: 区間の途中（3 桁目）から全角 2 字", () => {
    expect(run("あい", 0, 2)).toMatchObject({ segs: ["__<あい>", "________", "________"], placed: 2 });
  });
  it("カーソルは動かさない（貼る前の位置を返す）", () => {
    expect(run("AB", 1, 3).cursor).toEqual({ seg: 1, c: 3 });
  });
  it("エラーで止まればそこまでが入り、理由を返す（満杯の鎖の挿入は 0012）", () => {
    const full = [seg("ABCDEFGH"), seg("ABCDEFGH"), seg("ABCDEFGH")];
    const r = chainPaste(full, { seg: 2, c: 0 }, ["X"], true);
    expect(r.error).toBe(0x12);
    expect(r.placed).toBe(0);
  });
});
