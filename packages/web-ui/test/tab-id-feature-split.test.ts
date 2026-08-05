import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makePaneTabId, paneFeatureOf, paneLabelOf } from "../src/paneLabels.js";

/**
 * **タブ ID からは必ず機能 ID を取り出してから使う**（`20260802-tabs-own-system`）。
 *
 * タブ ID にはシステムが付く（`list:jobs@own:s1`）。接頭辞を剥がすだけだと
 * `jobs@own:s1` が残り、**そのまま API のパスや分岐のキーになる**。
 * 実際に一覧ペインがそれで落ちていた——`unknown list kind: jobs@own:s-…`（404）。
 * 素の機能 ID（`list:jobs`）でしかテストしていなかったので、誰も気づけなかった。
 *
 * **同じ形は次のペインでも書ける**ので、書き方そのものを走査して塞ぐ
 * （`ebcdic-not-reexported.test.ts` や `import-from-owner.test.ts` と同じ考え方——
 * 型検査では止まらない規約は、走査で止める）。
 */

const DIR = existsSync("src/components") ? "src/components" : "packages/web-ui/src/components";

/** `props.tabId.replace(/^xxx:/, "")` のような、システム部分を落とさない剥がし方 */
const RAW_STRIP = /(props\.)?tabId\s*\.\s*(replace|slice|split|substring)\s*\(/g;

describe("タブ ID の分解", () => {
  it("`paneFeatureOf` はシステム部分を落とす", () => {
    expect(paneFeatureOf(makePaneTabId("list:jobs", "own:s-1"))).toBe("list:jobs");
    expect(paneFeatureOf("list:jobs")).toBe("list:jobs"); // 付いていなくても素通し
  });

  it("表示名はシステム付きでも引ける", () => {
    expect(paneLabelOf(makePaneTabId("list:jobs", "own:s-1"))).toBe("ジョブ");
  });

  it("ペインは `tabId` を直接剥がさない（必ず `paneFeatureOf` を通す）", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".vue"))) {
      const src = readFileSync(join(DIR, f), "utf8");
      for (const m of src.matchAll(RAW_STRIP)) {
        // `paneFeatureOf(props.tabId).replace(...)` は正しい形なので除く
        const before = src.slice(Math.max(0, m.index - 40), m.index);
        if (!before.includes("paneFeatureOf(")) offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders, "システム部分（`@own:…`）が残ったまま使われる").toEqual([]);
  });
});
