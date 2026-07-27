import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectWindowRect, detectFkeyLegends } from "../src/composables/fkeyLegend.js";
import type { Cell, ScreenSnapshot } from "@as400web/core";

/**
 * **窓が重なったときは前面の窓を選ぶ。**
 *
 * ホストの ATNPGM の窓（Attn）は枠を反転で描き、F1 ヘルプの窓は罫線文字で描く。両方が同時に
 * 出ることがあり、`detectWindowRect` が「最初に当たった経路」を返していたため、
 * **後ろの窓が選ばれる**ことがあった。装飾が後ろに付くだけでなく、**後ろの窓の F キー凡例が
 * 押せるまま残る**——前面は Attn の窓なのでラベルと違う動作になる（#163 で塞いだ危険の再発）。
 *
 * fixture は実機の WRKMBRPDM で採った 7 スナップショット。
 * 「前面の窓が後ろの窓の枠を上書きする」という原理がそのままデータに出ており、
 * **誤るのは「前面が後ろの内側に収まったとき」だけ**だと分かった（lib / opt）。
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "window-stack");

interface Line { text: string; rev: string; und: string; kind: string }
interface Fixture { rows: number; cols: number; cursor: { row: number; col: number }; lines: Line[] }

const KIND: Record<string, Cell["kind"]> = {
  s: "sbcs", L: "dbcs-lead", T: "dbcs-tail", a: "attr", o: "so", i: "si"
};

/** 圧縮 fixture（行ごとの text / 反転 / 下線 / 種別のビット列）から ScreenSnapshot を組む */
function load(name: string): ScreenSnapshot {
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
  return {
    sessionId: "fx", rows: f.rows, cols: f.cols, cursor: f.cursor,
    keyboardLocked: false, cells, fields: []
  } as unknown as ScreenSnapshot;
}

const rectOf = (name: string) => detectWindowRect(load(name));
const legendRows = (name: string) => [...new Set(detectFkeyLegends(load(name)).map((l) => l.row))].sort((a, b) => a - b);

/** 実機で採った Attn 窓の位置（どのパターンでも同じ） */
const ATTN = { row1: 18, row2: 23, col1: 24, col2: 78 };

describe("窓が重なったときの前面判定", () => {
  describe("ヘルプ窓だけ（従来どおり）", () => {
    it.each([
      ["ov-file-help", { row1: 5, row2: 17, col1: 17, col2: 78 }],
      ["ov-lib-help", { row1: 6, row2: 23, col1: 17, col2: 78 }],
      ["ov-opt-help", { row1: 10, row2: 23, col1: 7, col2: 78 }]
    ])("%s は罫線枠を返す", (name, want) => {
      expect(rectOf(name as string)).toEqual(want);
    });
  });

  /**
   * Attn の窓がヘルプ窓の**下枠を潰した**ケース。罫線枠が候補にならないので、
   * 修正前から正しく Attn の窓が選ばれていた（この挙動を壊さないための固定）。
   */
  it("ヘルプの枠を壊す位置に Attn が来たら Attn を返す（file）", () => {
    expect(rectOf("ov-file-attn")).toEqual(ATTN);
    expect(legendRows("ov-file-attn"), "Attn の凡例行だけ").toEqual([23]);
  });

  /**
   * **修正の本体**。Attn の窓がヘルプ窓の内側に収まると、ヘルプの枠が生き残って
   * 後ろが選ばれていた。凡例もヘルプ側（21,22 行）と Attn 側（23 行）で混ざっていた。
   */
  it.each(["ov-lib-attn", "ov-opt-attn"])("%s は内側の Attn を前面として返す", (name) => {
    expect(rectOf(name)).toEqual(ATTN);
  });

  it("内側に Attn が来たとき、凡例は Attn の窓の分だけになる", () => {
    expect(legendRows("ov-lib-attn")).toEqual([23]);
    expect(legendRows("ov-opt-attn")).toEqual([23]);
  });

  /**
   * 逆順（Attn を出してからヘルプ）。ヘルプがAttn の反転枠を上書きして壊すので、
   * 反転枠は候補にならずヘルプが前面。修正で変わってはいけない。
   */
  it("Attn の上にヘルプが出たらヘルプを返す（逆順）", () => {
    expect(rectOf("rev-attn-then-help")).toEqual({ row1: 3, row2: 18, col1: 17, col2: 78 });
    expect(legendRows("rev-attn-then-help"), "ヘルプの凡例行だけ").toEqual([16, 17]);
  });
});
