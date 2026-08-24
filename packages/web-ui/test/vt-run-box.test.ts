import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * **VT も「run の箱＝行送り」で背景を塗る。**
 *
 * 素のインライン要素は内容領域（フォントの ascent+descent）にしか背景を塗らないので、
 * 背景色（SGR 40-47 / 反転 7）の行が縦に続くと行間に地色が横線として並ぶ。
 * VT は背景色を面で敷くアプリ（`vi` / `mc` / `tmux`）が普通なので、5250 より目立つ。
 *
 * **固定量を足す手（box-shadow / padding）は使わない**——必要な量は
 * 「行送り − 内容領域」÷2 で、内容領域はフォントごとに違うため、1em を前提にした固定量は
 * 内容領域の広いフォントで隣の行へはみ出す。`ScreenGrid.vue`（5250 / 3270）と同じ考え方。
 *
 * 実画素の確認は `scripts/verify-browser-vt-reverse.mjs`（jsdom は描画しない）。
 */
const CANDIDATES = ["packages/web-ui/src", "src"];
const read = (rel: string): string => {
  for (const base of CANDIDATES) {
    try {
      return readFileSync(resolve(process.cwd(), base, rel), "utf8");
    } catch {
      /* もう片方の cwd を試す */
    }
  }
  throw new Error(`${rel} が見つからない`);
};

const vt = read("components/VtPane.vue");

/** 選択子の宣言ブロック（コメントは先に落とし、選択子は正規化して完全一致で探す） */
function block(source: string, selector: string): string {
  const want = selector.replace(/\s+/g, "");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const chunk of stripped.split("}")) {
    const i = chunk.indexOf("{");
    if (i < 0) continue;
    const sel = chunk.slice(0, i).replace(/\s+/g, "");
    if (sel === want) return chunk.slice(i + 1);
  }
  throw new Error(`${selector} の定義が無い`);
}

describe("VT の背景色は行間を塗り残さない", () => {
  it("run の箱の高さが行送り（--vt-line-h）と一致する", () => {
    const line = block(vt, ".vt-line");
    expect(line).toContain("height: var(--vt-line-h)");
    const run = block(vt, ".vt-line span");
    expect(run).toContain("display: inline-block");
    expect(run).toContain("height: var(--vt-line-h)"); // 行と同じ変数から取る
    expect(run).toContain("vertical-align: top"); // 箱の上端を行の上端へ
  });

  it("run の見た目は固定量で広げない", () => {
    const run = block(vt, ".vt-line span");
    for (const prop of ["box-shadow", "margin", "border", "line-height"]) {
      expect(run, `.vt-line span が ${prop} を宣言している（フォント依存で隣の行へ出る）`).not.toMatch(
        new RegExp(`(^|;)\\s*${prop}\\s*:`)
      );
    }
  });
});
