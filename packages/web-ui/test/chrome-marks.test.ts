import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mount } from "@vue/test-utils";
import StatusBar from "../src/components/StatusBar.vue";
import DesignMenu from "../src/components/DesignMenu.vue";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import type { SessionState } from "../src/stores/sessions.js";
import type { WsClient } from "../src/ws-client.js";

/**
 * **ヘッダー・フッターの印**（`20260802-chrome-icon-polish`）。
 *
 * 利用者の指摘 4 件をここで固定する:
 *
 * 1. デザイン切替ボタンに三角を出さない（ヘッダーの他のメニューは持っていない）
 * 2. ログのトグルの三角を「その他」と同じ字にする（`▴`/`▾` は SMALL TRIANGLE で一回り小さい）
 * 3. HTML 保存の印を JSONL の書き出しと揃える（どちらも「ファイルを落とす」操作）
 * 4. ログパネルを画面の中の重ねものより上へ（option の▾が透けていた）
 *
 * 3 と 4 はソースを読む形にしている——`App.vue` はマウントに一式が要り、
 * z-index は **jsdom が scoped CSS を計算しない**ので DOM からは測れない
 * （`grid-overlay-offset.test.ts` と同じ手）。
 */

/**
 * cwd はランナーの起動位置で変わる（workspace 単位 / リポジトリ直下）ので両方見る。
 *
 * **コメントは落とす。** 注記は「使ってはいけない字」を例として載せるので、
 * 残したまま検査すると自分の解説文を踏む（実際に踏んだ）。
 */
function src(rel: string): string {
  return readFileSync(existsSync(rel) ? rel : `packages/web-ui/${rel}`, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 先頭の三角（無ければ空文字）。字そのものを取り出して突き合わせる */
function mark(text: string): string {
  return /^\s*([▲▼▴▾])/.exec(text)?.[1] ?? "";
}

function state(): SessionState {
  return {
    sessionId: "s",
    label: "t",
    snapshot: { sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
      keyboardLocked: false, cells: [], fields: [] } as unknown as ScreenSnapshot,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: {} as WsClient
  };
}

describe("三角の印", () => {
  it("**「ログ」と「その他」の三角が同じ字**（並べて揃って見える）", async () => {
    const w = mount(StatusBar, { props: { state: state(), logCount: 3 } });
    const log = mark(w.find(".logbtn").text());
    const more = mark(w.find(".fk.more").text());
    expect(log, "ログのトグルに三角が無い").not.toBe("");
    expect(log).toBe(more);
  });

  it("開いた側でも同じ字（`▼`）", async () => {
    const w = mount(StatusBar, { props: { state: state(), logCount: 3, logOpen: true } });
    await w.find(".fk.more").trigger("click");
    expect(mark(w.find(".logbtn").text())).toBe("▼");
    expect(mark(w.find(".fk.more").text())).toBe("▼");
  });

  it("**SMALL TRIANGLE（`▴`/`▾`）は使わない**（`▲`/`▼` と混ざると大きさが揃わない）", () => {
    // SQL 画面の「実行ログ」も同じ `.logbtn`。マウントに一式要るのでソースで見る
    for (const f of ["src/components/StatusBar.vue", "src/components/SqlPane.vue"]) {
      const logBtnLines = src(f).split("\n").filter((l) => /ログ <span class="cnt"/.test(l));
      expect(logBtnLines.length, `${f} にログのトグルが無い＝当てが外れている`).toBe(1);
      expect(logBtnLines[0], f).not.toMatch(/[▴▾]/);
      expect(logBtnLines[0], f).toMatch(/[▲▼]/);
    }
  });

  it("**デザイン切替ボタンに三角を出さない**", () => {
    const w = mount(DesignMenu);
    expect(w.find(".dz-btn").text()).not.toMatch(/[▲▼▴▾]/);
    // 開くボタンであることは支援技術へ属性で伝わり続ける
    expect(w.find(".dz-btn").attributes("aria-haspopup")).toBe("menu");
  });
});

describe("ダウンロードの印", () => {
  it("**HTML 保存も JSONL 書き出しと同じ `⬇`**（どちらもファイルを落とす操作）", () => {
    expect(src("src/App.vue")).toMatch(/⬇ HTML/);
    expect(src("src/App.vue"), "文書の印（🖹）が残っている").not.toMatch(/🖹/);
    expect(src("src/components/LogPanel.vue")).toMatch(/⬇ JSONL/);
  });
});

describe("重なり順", () => {
  /** scoped CSS から z-index の数を全部拾う */
  function zIndexes(file: string): number[] {
    const style = /<style scoped>([\s\S]*)<\/style>/.exec(src(file))?.[1] ?? "";
    return [...style.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));
  }

  it("**ログパネルは画面の中の重ねものより上**（option の▾が透けない）", () => {
    // `.grid` は position:relative でも z-index:auto なのでスタッキングコンテキストを作らない。
    // 中の z-index がそのままこの階層へ出るため、パネル側が上回っていないと透ける
    const inScreen = Math.max(...zIndexes("src/components/ScreenGrid.vue"));
    for (const panel of ["src/components/LogPanel.vue", "src/components/SqlLogPanel.vue"]) {
      expect(Math.max(...zIndexes(panel)), `${panel} が画面内の最大 ${inScreen} を上回らない`).toBeGreaterThan(inScreen);
    }
  });
});
