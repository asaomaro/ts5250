import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectWindowRect, sameScreen } from "../src/composables/fkeyLegend.js";
import type { Cell, ScreenSnapshot, WriteExtent } from "@as400web/core";

/**
 * **窓は背景の上に開く——枠の外に新しい内容が出ていなければ窓。**
 *
 * 受信データ（`WriteExtent`）では ③（左右に `:` が並ぶ帳票）と ①（F1 ヘルプ窓）を分けられない
 * ことが実機で確定した（`real-help-window.test.ts`）。ヘルプ窓も CLEAR ＋ 全画面書き直しで来るため。
 * 残る材料が**前画面との差分**で、こちらは画面と画面を比べるので全画面書き直しでも効く。
 *
 * 【実測 2026-07-29 / 実機・IBM i 7.5・34 対（本物の窓 9・通常画面 25）】
 *
 * | 条件 | 窓を保つ | 通常を誤検出 |
 * |---|---|---|
 * | 枠の**内側**矩形の外を比較 | 1/9 | 0/25 |
 * | **外周**を含めた矩形の外を比較 | 6/9 | 0/25 |
 * | 外周 ＋ **「文字→空白」を無視** | **9/9** | **0/25** |
 *
 * 素直に書くと窓の大半を落とす。理由は `introducedOutside` の注記に書いた。
 * この fixture はその 2 つの落とし穴を踏み直さないための回帰資産。
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "window-prev-diff");

interface Line { text: string; rev: string; und: string; kind: string }
interface Snap {
  rows: number; cols: number; cursor: { row: number; col: number };
  lines: Line[]; lastWrite?: WriteExtent;
}
interface Pair { label: string; prev: Snap; cur: Snap }
interface Index { name: string; label: string; window: boolean }

const KIND: Record<string, Cell["kind"]> = {
  s: "sbcs", L: "dbcs-lead", T: "dbcs-tail", a: "attr", o: "so", i: "si"
};

function toSnap(f: Snap): ScreenSnapshot {
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
  const s = {
    sessionId: "fx", rows: f.rows, cols: f.cols, cursor: f.cursor,
    keyboardLocked: false, cells, fields: []
  } as unknown as ScreenSnapshot;
  if (f.lastWrite) s.lastWrite = f.lastWrite;
  return s;
}

const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as Index[];
const load = (name: string): Pair => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Pair;

const windows = index.filter((e) => e.window);
const normals = index.filter((e) => !e.window);

describe("前画面との差分による窓判定（実機 fixture）", () => {
  it(`本物の窓を 1 つも落とさない（${windows.length} 対）`, () => {
    const missed: string[] = [];
    for (const e of windows) {
      const p = load(e.name);
      const rect = detectWindowRect(toSnap(p.cur), undefined, toSnap(p.prev));
      if (!rect) missed.push(e.label);
    }
    expect(missed).toEqual([]);
  });

  it("前画面を渡しても矩形は変わらない（裏取りは通すか落とすかだけ）", () => {
    for (const e of windows) {
      const p = load(e.name);
      const without = detectWindowRect(toSnap(p.cur));
      const withPrev = detectWindowRect(toSnap(p.cur), undefined, toSnap(p.prev));
      expect(withPrev).toEqual(without);
    }
  });

  it(`通常画面を窓と誤検出しない（${normals.length} 対）`, () => {
    const wrong: string[] = [];
    for (const e of normals) {
      const p = load(e.name);
      if (detectWindowRect(toSnap(p.cur), undefined, toSnap(p.prev))) wrong.push(e.label);
    }
    expect(wrong).toEqual([]);
  });
});

// --- ③ 帳票（合成）。実機 25 画面では再現しなかったため合成で組む ---

const ROWS = 24;
const COLS = 80;
const pad = (col: number, s: string) => " ".repeat(col - 1) + s;

function synth(text: Record<number, string>): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= ROWS; r++) {
    const line = text[r] ?? "";
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) {
      row.push({
        char: line[c - 1] ?? " ",
        kind: "sbcs", color: "green",
        reverse: false, underline: false, blink: false,
        columnSeparator: false, nonDisplay: false
      } as Cell);
    }
    cells.push(row);
  }
  return {
    sessionId: "s", rows: ROWS, cols: COLS, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: []
  } as unknown as ScreenSnapshot;
}

const MENU = {
  1: "MAIN                        IBM I メインメニュー",
  3: "次の 1 つを選択してください。",
  5: "     1. ユーザー・タスク",
  6: "     2. オフィス・タスク"
};
/** ③ 表（左右に `:` が並ぶ帳票）。罫線経路が誤検出していた形 */
const TABLE = {
  1: "                          在庫明細照会                    S1234567",
  3: pad(5, "-".repeat(70)),
  4: pad(5, ":") + pad(69, ":"),
  5: pad(5, ":") + pad(69, ":"),
  6: pad(5, ":") + pad(69, ":"),
  7: pad(5, ":") + pad(69, ":"),
  8: pad(5, "-".repeat(70)),
  10: "  品番      品名            数量    単価",
  11: "  A-001     ボルト           120     35",
  24: "F3=終了  F12=取消し"
};

describe("③ 帳票の誤検出", () => {
  it("前画面が無ければ従来どおり誤検出する（回帰の再現）", () => {
    expect(detectWindowRect(synth(TABLE))).not.toBeNull();
  });

  it("メニューからの遷移なら窓と判定しない（枠の外に新しい内容が出ている）", () => {
    expect(detectWindowRect(synth(TABLE), undefined, synth(MENU))).toBeNull();
  });
});

describe("同じ画面の無変化な再描画", () => {
  it("sameScreen が true になる（呼び出し側は判定を更新しない）", () => {
    expect(sameScreen(synth(TABLE), synth(TABLE))).toBe(true);
  });

  it("1 セルでも違えば false", () => {
    expect(sameScreen(synth(TABLE), synth({ ...TABLE, 24: "F3=終了" }))).toBe(false);
  });

  it("画面サイズが違えば false", () => {
    const wide = { ...synth(TABLE), rows: 27, cols: 132 } as ScreenSnapshot;
    expect(sameScreen(synth(TABLE), wide)).toBe(false);
  });

  it("**判定し直すと窓になってしまう**（前回の結論を保つ必要がある根拠）", () => {
    // 同じ画面同士を比べると枠外も無変化なので、裏取りは通ってしまう。
    // だから呼び出し側は sameScreen のとき判定を更新しない
    expect(detectWindowRect(synth(TABLE), undefined, synth(TABLE))).not.toBeNull();
  });
});

describe("画面サイズが変わったとき", () => {
  it("比較を諦めて従来どおりの結果を返す", () => {
    const wide = { ...synth(MENU), rows: 27, cols: 132 } as ScreenSnapshot;
    expect(detectWindowRect(synth(TABLE), undefined, wide)).toEqual(detectWindowRect(synth(TABLE)));
  });
});
