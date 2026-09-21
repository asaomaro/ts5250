import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { code } from "./source-scan.js";

/**
 * **`dbcsType` の取り置きは、呼び出し側が毎回明示する**
 * （`20260920-insert-mode-overflow` review ラウンド 2 の must）。
 *
 * この引数は**2 ラウンド続けて、違う理由で漏れた**——
 * 1 度目は「既定値のまま呼んでいた」、2 度目は「第 4 引数を渡し忘れた」。
 * どちらも**型検査では捕まらない**（既定値があるので引数なしでも通る）し、
 * 漏れても多くの画面では症状が出ない（符号付き・DBCS 専用欄でしか割れない）。
 *
 * 既定の `reserve = e.insertMode` は、選択置換で `insertMode: true` に化けた `base` を
 * そのまま見てしまうため、**上書きの利用者に挿入用の取り置きが掛かる**（退行）。
 * だから「既定に任せない」ことそのものを固定する。
 *
 * 条項 `paired-artifact-sync`: 対になる経路（打鍵 / IME / ペースト）の片方だけを直さない。
 */
describe("dbcsType の取り置きは呼び出し側が明示する", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = code(readFileSync(join(root, "src/components/ScreenGrid.vue"), "utf8"));

  it("すべての呼び出しが第 4 引数を渡している（既定に任せない）", () => {
    // 定義行（`function dbcsType(`）と、`f.dbcsType` のようなプロパティ参照は対象外
    const calls = [...src.matchAll(/(?<![.\w])dbcsType\(/g)]
      .map((m) => m.index!)
      .filter((i) => !/function\s+$/.test(src.slice(Math.max(0, i - 12), i)));
    expect(calls.length, "呼び出しが見つからない＝走査が壊れている").toBeGreaterThanOrEqual(3);

    const missing: string[] = [];
    for (const start of calls) {
      // 対応する閉じ括弧まで読んで、トップレベルのカンマを数える
      let depth = 0;
      let commas = 0;
      let i = src.indexOf("(", start);
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        } else if (c === "," && depth === 1) commas++;
      }
      if (commas < 3) missing.push(src.slice(start, i + 1).replace(/\s+/g, " "));
    }
    expect(missing, "第 4 引数（reserve）を渡していない呼び出し").toEqual([]);
  });
});
