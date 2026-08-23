import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectWindowRect } from "../src/composables/fkeyLegend.js";
import type { Cell, ScreenSnapshot, WriteExtent } from "@ts5250/tn5250";

/**
 * **実機（IBM i 7.3）のメインメニューで F1 を押したヘルプ窓。**
 *
 * backlog の実測表でいう ①（本物の窓。上下 `.`・左右 `:`・枠外の非空白 130 セル）そのもの。
 * 2026-07-29 に実機から採取した。同時に採った `lastWrite` が重要:
 *
 * ```
 * {"cleared":true,"restored":false,"cells":1892,"rect":{"row1":1,"row2":24,"col1":1,"col2":80}}
 * ```
 *
 * **CLEAR を伴う全画面書き込みで来る。** つまり「本物の窓は背景を消さずに窓の領域だけ書く」は
 * IBM i のヘルプ・パネルには当てはまらない——ホストは画面をクリアしてから、背景の見出し行ごと
 * 箱を描き直す。受信データ上、これは通常画面と区別が付かない。
 *
 * 一方、Attn の窓（ATNPGM。反転枠）は実測で
 * `{"cleared":false,"cells":353,"rect":{"row1":18,"row2":24,...}}` ＝**部分書き込み**で来る。
 *
 * よって書き込み範囲は「重ね書きの窓」だけを言い当てられる材料で、
 * **ヘルプ窓と通常画面を分けることはできない**。このテストはその境界を固定する。
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "window-stack");

interface Line { text: string; rev: string; und: string; kind: string }
interface Fixture {
  rows: number;
  cols: number;
  cursor: { row: number; col: number };
  lines: Line[];
  lastWrite?: WriteExtent;
}

const KIND: Record<string, Cell["kind"]> = {
  s: "sbcs", L: "dbcs-lead", T: "dbcs-tail", a: "attr", o: "so", i: "si"
};

function load(name: string, withExtent: boolean): ScreenSnapshot {
  const f = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fixture;
  const cells: Cell[][] = f.lines.map((ln) =>
    [...Array(f.cols).keys()].map((i) => ({
      char: ln.text[i] ?? " ",
      kind: KIND[ln.kind[i] ?? "s"] ?? "sbcs",
      color: "green",
      reverse: ln.rev[i] === "1",
      underline: ln.und[i] === "1",
      blink: false,
      columnSeparator: false,
      nonDisplay: false
    })) as Cell[]
  );
  const snap = {
    sessionId: "fx", rows: f.rows, cols: f.cols, cursor: f.cursor,
    keyboardLocked: false, cells, fields: []
  } as unknown as ScreenSnapshot;
  if (withExtent && f.lastWrite) snap.lastWrite = f.lastWrite;
  return snap;
}

describe("実機の F1 ヘルプ窓", () => {
  it("罫線からは窓として検出できる（従来の判定）", () => {
    const rect = detectWindowRect(load("real-help-menu", false));
    expect(rect).not.toBeNull();
    // 上下の `.` と左右の `:` で囲まれた箱の内側
    expect(rect!.row1).toBeGreaterThanOrEqual(3);
    expect(rect!.row2).toBeLessThanOrEqual(24);
    expect(rect!.col1).toBeGreaterThanOrEqual(1);
  });

  it("実機の lastWrite は CLEAR ＋ 全画面である（前提が成り立たない証拠）", () => {
    const f = JSON.parse(
      readFileSync(join(DIR, "real-help-menu.json"), "utf8")
    ) as Fixture;
    expect(f.lastWrite).toEqual({
      cleared: true,
      restored: false,
      cells: 1892,
      rect: { row1: 1, row2: 24, col1: 1, col2: 80 }
    });
  });

  it("書き込み範囲を見ても窓と分からない（通常画面と同じ形をしている）", () => {
    // **ここが設計上の限界**。CLEAR ＋ 全画面という受信データの形は通常画面と同一で、
    // これを「窓ではない」と切ると本物のヘルプ窓を落とす。
    // したがって判定は従来どおり罫線に委ねる（`lastWrite` があっても結果を変えない）。
    const withExtent = detectWindowRect(load("real-help-menu", true));
    const without = detectWindowRect(load("real-help-menu", false));
    expect(withExtent).toEqual(without);
    expect(withExtent).not.toBeNull();
  });
});
