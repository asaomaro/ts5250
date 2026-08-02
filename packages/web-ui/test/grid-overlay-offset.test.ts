import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { GRID_PAD_X, GRID_PAD_Y } from "../src/composables/fitFont.js";
import type { ScreenSnapshot, Cell } from "@as400web/tn5250";

/**
 * **重ねる要素の余白補正**（`20260802-cursor-pad-offset`）。
 *
 * `.grid` に絶対配置で重ねるもの（カーソル・矩形選択・罫線・窓枠・GUI 部品）は、
 * 絶対配置の基準が祖先の **padding box** である都合上、`.grid` の内側余白ぶんだけ
 * margin で内側へ寄せている。この補正が余白の実値と食い違うと、**重ねるものが丸ごとずれる**。
 *
 * 実際に踏んだ: 余白を ACS 相当へ詰めた (#274) とき、`margin: 8px 0 0 10px` の直書きが
 * **12 か所**取り残され、カーソルが右へ 8px・下へ 7px ずれた（利用者から画像つきで報告）。
 *
 * **jsdom は scoped CSS を計算しない**ので、ここでは「ずれた位置」ではなく
 * **ずれを生む書き方**を落とす——数字の直書きと、var が届かない配置。
 * 実際の位置一致は `scripts/verify-cursor-align.mjs` が実ブラウザで測る。
 */

/**
 * SFC のソースを素で読む。**`import.meta.url` は使えない**——jsdom 環境では
 * file URL ではなく http URL になり `fileURLToPath` が投げる（実際に踏んだ）。
 * cwd はランナーの起動位置で変わる（workspace 単位 / リポジトリ直下）ので両方見る。
 */
const REL = "src/components/ScreenGrid.vue";
const SRC = readFileSync(existsSync(REL) ? REL : `packages/web-ui/${REL}`, "utf8");

/**
 * `<style scoped>` の**宣言だけ**（script の文字列も、CSS コメントも対象外）。
 * コメントを落とすのは、注記が「してはいけない書き方」を例として載せるから
 * ——`var(--grid-pad-x, 2px)` と書いた解説を検査に引っ掛けても意味がない。
 */
function styleBlock(): string {
  const m = /<style scoped>([\s\S]*)<\/style>/.exec(SRC);
  expect(m, "<style scoped> が見つからない").toBeTruthy();
  return m![1]!.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `<template>` の中身 */
function templateBlock(): string {
  const m = /<template>([\s\S]*)<\/template>/.exec(SRC);
  expect(m, "<template> が見つからない").toBeTruthy();
  return m![1]!;
}

function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green",
    reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false
  };
}

function snap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(Array.from({ length: 80 }, cell));
  return { sessionId: "s", rows: 24, cols: 80, cursor: { row: 3, col: 7 }, keyboardLocked: false, cells, fields: [] };
}

describe("重ねる要素の余白補正", () => {
  it("**余白の px を CSS に直書きしない**（唯一の定義は `fitFont.ts` の `GRID_PAD_*`）", () => {
    // margin は「余白の足し戻し」か「0」のどちらかしか要らない。
    // 数字が出てきたら、それは余白の値をもう 1 か所に写したということ。
    const margins = [...styleBlock().matchAll(/^\s*margin:\s*([^;]+);/gm)].map((m) => m[1]!.trim());
    expect(margins.length, "margin 宣言が 1 つも無い＝正規表現が腐っている").toBeGreaterThan(0);
    const bad = margins.filter((v) => v !== "0" && !v.includes("var(--grid-pad-"));
    expect(bad, "余白ぶんの補正は var(--grid-pad-*) から読むこと").toEqual([]);
  });

  it("**フォールバック値も書かない**（`var(--grid-pad-x, 2px)` は数字を 1 か所増やす）", () => {
    expect(styleBlock()).not.toMatch(/var\(--grid-pad-[xy]\s*,/);
  });

  it("`--grid-pad-*` は `.grid` が実値から流し込む", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(), edits: new Map(), focused: true } });
    const style = (w.find(".grid").element as HTMLElement).style;
    expect(style.getPropertyValue("--grid-pad-x")).toBe(`${GRID_PAD_X}px`);
    expect(style.getPropertyValue("--grid-pad-y")).toBe(`${GRID_PAD_Y}px`);
  });

  it("**重ねるものは `.grid` の中に置く**（カスタムプロパティは継承でしか届かない）", () => {
    const w = mount(ScreenGrid, { props: { snapshot: snap(), edits: new Map(), focused: true } });
    // カーソルは常に出るので代表として見る（他の重ねものは条件付きで描かれる）
    expect(w.find(".grid > .cursor").exists()).toBe(true);
    // Teleport で外へ出すと var が届かず、補正が無音で 0 になる
    expect(templateBlock()).not.toMatch(/<Teleport|<teleport/);
  });
});
