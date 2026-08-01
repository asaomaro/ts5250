import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOptionHints, detectOptionColumn } from "../src/composables/fkeyLegend.js";
import type { Cell, Field, ScreenSnapshot } from "@as400web/tn5250";

/**
 * **オプション欄のドロップダウンの検出。**
 *
 * `WRKxxx` / PDM 系の一覧は、1〜2 桁の Opt 欄の上に必ず `2=変更 3=コピー …` の凡例が出る。
 * 材料は画面にすべて出ているので、機能キー凡例（`F<n>=`）と同じ仕組みで拾える。
 *
 * 【Opt 列の形 — 実機・IBM i 7.3 で 5 画面を実測 2026-07-29】
 *
 * | 画面 | Opt 欄 | 並ぶ行 | 凡例行 |
 * |---|---|---|---|
 * | `WRKOBJPDM` | c2 / len2 | 11–18 | r7, r8 |
 * | `WRKSPLF`   | c2 / len2 | 12–20 | r6, r7 |
 * | `WRKACTJOB` | c2 / len2 | 10–18 | r6, r7 |
 * | `DSPLIBL`   | c3 / len1 | 9–15  | r6 |
 * | `WRKUSRJOB` | c2 / len2 | 9–18  | r4, r5 |
 *
 * **凡例と Opt 列の両方が揃ったときだけ発火する。** `<数字>=` は `F<n>=` よりはるかに紛れやすく
 * （金額・式・日付）、凡例だけを根拠にすると誤検出が利用者に見えるため。
 * `WRKMSGQ` とメニューはどちらも持たない負のケースとして入れてある。
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opt-legend");

interface Line { text: string; rev: string; und: string; kind: string }
interface Fx {
  rows: number; cols: number; cursor: { row: number; col: number };
  lines: Line[];
  fields: { index: number; row: number; col: number; length: number; protected: boolean; numeric: boolean; hidden: boolean }[];
}

const KIND: Record<string, Cell["kind"]> = {
  s: "sbcs", L: "dbcs-lead", T: "dbcs-tail", a: "attr", o: "so", i: "si"
};

function load(name: string): ScreenSnapshot {
  const f = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fx;
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
  return {
    sessionId: "fx", rows: f.rows, cols: f.cols, cursor: f.cursor,
    keyboardLocked: false, cells,
    fields: f.fields as unknown as Field[]
  } as unknown as ScreenSnapshot;
}

describe("Opt 列の検出（実機 fixture）", () => {
  it("WRKOBJPDM: c2 / 長さ 2 が 8 行", () => {
    expect(detectOptionColumn(load("wrkobjpdm"))).toEqual({
      col: 2, length: 2, rows: [11, 12, 13, 14, 15, 16, 17, 18]
    });
  });

  it("WRKSPLF: c2 / 長さ 2 が 9 行", () => {
    const c = detectOptionColumn(load("wrksplf"));
    expect(c?.col).toBe(2);
    expect(c?.length).toBe(2);
    expect(c!.rows.length).toBeGreaterThanOrEqual(3);
  });

  it("DSPLIBL: c3 / 長さ 1（1 桁の欄も拾う）", () => {
    const c = detectOptionColumn(load("dsplibl"));
    expect(c?.col).toBe(3);
    expect(c?.length).toBe(1);
    expect(c!.rows.length).toBeGreaterThanOrEqual(3);
  });

  it("WRKMSGQ・メニューには Opt 列が無い", () => {
    expect(detectOptionColumn(load("wrkmsgq"))).toBeNull();
    expect(detectOptionColumn(load("menu"))).toBeNull();
  });
});

describe("凡例と Opt 列の結び付け（実機 fixture）", () => {
  it("WRKOBJPDM の凡例を 2 行にまたいで拾う", () => {
    const hints = detectOptionHints(load("wrkobjpdm"));
    expect(hints).not.toBeNull();
    const values = hints!.options.map((o) => o.value);
    // r7: 2 3 4 5 7 / r8: 8 9 10 11
    expect(values).toEqual(["2", "3", "4", "5", "7", "8", "9", "10", "11"]);
    expect(hints!.options.find((o) => o.value === "2")?.label).toBe("変更");
    expect(hints!.options.find((o) => o.value === "3")?.label).toBe("コピー");
    // ラベルに空白 1 個が入るものも 1 件として拾える
    expect(hints!.options.find((o) => o.value === "7")?.label).toBe("名前の変更");
  });

  it("DSPLIBL は凡例が 1 件でも成立する", () => {
    const hints = detectOptionHints(load("dsplibl"));
    expect(hints).not.toBeNull();
    expect(hints!.options.map((o) => o.value)).toEqual(["5"]);
  });

  it("WRKSPLF の凡例を拾う", () => {
    const hints = detectOptionHints(load("wrksplf"));
    expect(hints).not.toBeNull();
    expect(hints!.options.map((o) => o.value)).toContain("2");
    expect(hints!.options.map((o) => o.value)).toContain("11");
  });

  it("凡例も Opt 列も無い画面は null", () => {
    // この 2 つは**凡例が無い**ので null になる。規則「両方揃ったときだけ」を突くのは次のケース
    expect(detectOptionHints(load("wrkmsgq"))).toBeNull();
    expect(detectOptionHints(load("menu"))).toBeNull();
  });

  it("**凡例があっても Opt 列が無ければ null**（両方揃ったときだけ発火する）", () => {
    // 実機 PDM から入力欄だけを取り去る。凡例（2=変更 …）はそのまま残っている
    const snap = load("wrkobjpdm");
    const noFields = { ...snap, fields: [] } as ScreenSnapshot;
    expect(detectOptionColumn(noFields)).toBeNull();
    expect(detectOptionHints(noFields)).toBeNull();
  });

  it("短い欄が 2 行しか並ばなければ Opt 列とみなさない", () => {
    const snap = load("wrkobjpdm");
    const two = { ...snap, fields: snap.fields.filter((f) => f.row <= 12) } as ScreenSnapshot;
    expect(detectOptionColumn(two)).toBeNull();
    expect(detectOptionHints(two)).toBeNull();
  });

  it("機能キー凡例（F3= / F24=）は拾わない", () => {
    const hints = detectOptionHints(load("wrkobjpdm"));
    // fixture の r22-23 に F3= F4= F5= F6= F9= F10= F23= F24= がある
    for (const o of hints!.options) {
      expect(o.row).toBeLessThan(11); // Opt 列より上の行だけ
    }
    expect(hints!.options.map((o) => o.value)).not.toContain("24");
    expect(hints!.options.map((o) => o.value)).not.toContain("23");
  });

  it("欄の長さに収まらない番号は選ばせない", () => {
    // DSPLIBL は長さ 1 の欄。2 桁の番号があっても出さない
    const hints = detectOptionHints(load("dsplibl"));
    for (const o of hints!.options) expect(o.value.length).toBeLessThanOrEqual(1);
  });
});
