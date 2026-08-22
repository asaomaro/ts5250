import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectWindowRect } from "../src/composables/fkeyLegend.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **入力欄が枠の外に出ていたら窓ではない**（backlog `window-detect.md` の補助条件）。
 *
 * 罫線経路は条件が緩く（`BORDER_H` が 8 桁以上 × 2 本 ＋ 左右どちらかに `BORDER_V` が半数）、
 * **左右に `:` が並ぶ帳票を窓と誤る**（backlog の実測 ③）。
 *
 * ## なぜ入力欄で裏が取れるのか（実機で測った）
 *
 * 2026-08-22 に SR-OSAKA（IBM i 7.3）で採取（`scripts/diag-window-fields-osaka.mjs`）:
 *
 * | 画面 | 入力欄 |
 * |---|---|
 * | WRKOBJPDM（背景） | **12 個**（見出し 3・オプション列 8・コマンド行 1） |
 * | その上に F1 ヘルプ窓 | **1 個だけ**（`r11c9` ＝ 窓の内側） |
 * | メインメニュー（窓なし） | 1 個（コマンド行） |
 * | メインメニューの F1 ヘルプ窓 | 1 個（窓の内側） |
 *
 * **窓が開くとホストは欄の一覧を丸ごと差し替える**——背景の欄は残らない。
 * だからこの条件は本物の窓を殺さない。実データは
 * `fixtures/window-stack/real-fields-pdm-help.json`。
 *
 * ⚠ **欄が 1 つも無い画面には掛からない**（空振りする）。ヘルプ窓は入力欄を持たないことが
 * 多いので、これは「効くときだけ効く」安価な補助にとどまる。**これだけで ③ が全部消えるとは
 * 考えないこと。**
 */

const here = dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(
  readFileSync(join(here, "fixtures", "window-stack", "real-fields-pdm-help.json"), "utf8")
) as { label: string; rows: number; cols: number; lines: string[]; inputs: { row: number; col: number; length: number }[] }[];

function cell(ch: string): Cell {
  return {
    char: ch,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

/** 全角は 2 セル（先頭＋継続）で置く。実機の行をそのまま食わせるため */
function toCells(line: string, cols: number): Cell[] {
  const out: Cell[] = [];
  for (const ch of line) {
    if (/[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿＀-｠]/u.test(ch)) {
      out.push({ ...cell(ch), kind: "dbcs-lead" });
      out.push({ ...cell(" "), kind: "dbcs-tail" });
    } else out.push(cell(ch));
  }
  while (out.length < cols) out.push(cell(" "));
  return out.slice(0, cols);
}

function field(row: number, col: number, length: number, index: number): Field {
  return { index, row, col, length, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
}

function snapOf(
  lines: string[],
  inputs: { row: number; col: number; length: number }[],
  rows = 24,
  cols = 80
): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) cells.push(toCells(lines[r] ?? "", cols));
  return {
    sessionId: "wib",
    rows,
    cols,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: inputs.map((f, i) => field(f.row, f.col, f.length, i + 1))
  } as ScreenSnapshot;
}

const real = (label: string): ScreenSnapshot => {
  const c = REAL.find((x) => x.label.includes(label));
  if (c === undefined) throw new Error(`fixture に ${label} が無い`);
  return snapOf(c.lines, c.inputs, c.rows, c.cols);
};

describe("実機で採った窓（この条件が本物を殺さないことの証拠）", () => {
  it("**WRKOBJPDM の上の F1 ヘルプ窓は検出されたままになる**", () => {
    const rect = detectWindowRect(real("WRKOBJPDM の上に F1"));
    expect(rect).not.toBeNull();
  });

  it("その窓の入力欄は 1 個で、窓の内側にある（条件が成立する理由）", () => {
    const c = REAL.find((x) => x.label.includes("WRKOBJPDM の上に F1"))!;
    expect(c.inputs).toHaveLength(1);
    const rect = detectWindowRect(real("WRKOBJPDM の上に F1"))!;
    const f = c.inputs[0]!;
    expect(f.row).toBeGreaterThanOrEqual(rect.row1);
    expect(f.row).toBeLessThanOrEqual(rect.row2);
    expect(f.col).toBeGreaterThanOrEqual(rect.col1);
  });

  it("**背景（WRKOBJPDM 単体）は入力欄が 12 個ある**——窓が開くと差し替わることの対比", () => {
    const c = REAL.find((x) => x.label.includes("WRKOBJPDM（背景"))!;
    expect(c.inputs.length).toBeGreaterThan(10);
  });

  it("メインメニューの F1 ヘルプ窓も検出されたまま", () => {
    expect(detectWindowRect(real("F1 ヘルプ窓"))).not.toBeNull();
  });
});

describe("誤検出を切る（backlog の ③）", () => {
  /** 左右に `:` が並ぶ帳票。罫線経路の条件を満たしてしまう形 */
  const TABLE = [
    "  一覧                                                        S*******",
    "",
    "  ライブラリー . .   QGPL",
    "",
    "  ....................................................................",
    "  : 品目       数量    単価                                          :",
    "  : AAA          10     100                                          :",
    "  : BBB          20     200                                          :",
    "  : CCC          30     300                                          :",
    "  ....................................................................",
    "",
    "  パラメーターまたはコマンド",
    "  ===>",
    "  F3= 終了"
  ];

  it("枠の中に入力欄が収まっていれば従来どおり検出する（条件は空振り）", () => {
    // 枠は概ね r5-r10 / c3-c70。中だけに欄を置く
    expect(detectWindowRect(snapOf(TABLE, [{ row: 7, col: 10, length: 4 }]))).not.toBeNull();
  });

  it("**枠の外に入力欄があれば窓ではないと切る**（コマンド行が枠外にある帳票）", () => {
    expect(
      detectWindowRect(snapOf(TABLE, [{ row: 7, col: 10, length: 4 }, { row: 13, col: 7, length: 60 }]))
    ).toBeNull();
  });

  it("**欄が枠の内側から始まって外へはみ出す場合も切る**（右端まで見る）", () => {
    const rect = detectWindowRect(snapOf(TABLE, []))!;
    const over = { row: 7, col: rect.col2 - 1, length: 20 };
    expect(detectWindowRect(snapOf(TABLE, [over]))).toBeNull();
  });

  it("**保護欄は見ない**（背景の見出しは窓を否定しない）", () => {
    const snap = snapOf(TABLE, [{ row: 7, col: 10, length: 4 }]);
    // 枠の外に保護欄を足しても結果は変わらない
    (snap.fields as Field[]).push({
      index: 99, row: 1, col: 3, length: 20,
      protected: true, hidden: false, numeric: false, mdt: false, value: ""
    });
    expect(detectWindowRect(snap)).not.toBeNull();
  });

  it("欄が 1 つも無ければ従来どおり（条件は掛からない）", () => {
    expect(detectWindowRect(snapOf(TABLE, []))).not.toBeNull();
  });
});
