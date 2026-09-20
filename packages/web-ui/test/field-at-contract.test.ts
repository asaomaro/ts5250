import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fieldAtLabel, wsErrorNotice } from "../src/composables/opMessages.js";
import { code } from "./source-scan.js";

/**
 * **「欄の位置」は 6 か所の生産者と 1 つの正規表現の契約**で、その両側を結ぶものが無かった。
 *
 * サーバーの message を画面に出さなくしたので（`20260920-field-error-no-value` decisions D2）、
 * **利用者に残る唯一の手掛かりが位置**になった。その位置は core が文言に埋めた
 * `field at (行,桁)` を `opMessages.ts` の `fieldAtOf` が拾って作る。
 *
 * 書式を core 側で変えても、**core のテストを直せばそちらは緑になる**——
 * そして通知は黙って見出しだけに退化する（値も位置も無い一行になる）。
 * 片側だけで閉じない検査がここに要る（`20260920-field-error-no-value` の cross 点検の指摘。
 * 条項 `paired-artifact-sync`）。
 *
 * **走査で固定する理由**: web-ui は core を実行時に import しない
 * （`AGENTS.md`「web-ui はホストサーバーの型を実体から `import type` する」）。
 * 実体を呼べない以上、**書式リテラルそのもの**を見るのが両側を結ぶ唯一の手段になる。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * 位置を文言へ埋めている箇所（`file:line` は 2026-09-20 時点）。
 *
 * **ファイル単位ではなく「何個あるか」で数える。** `buffer.ts` は `FIELD_PROTECTED` と
 * `FIELD_OVERFLOW` の 2 か所で埋めており、「そのファイルのどこかに 1 つあれば緑」だと
 * **片方を書き換えても残りが当たって素通りする**（review ラウンド 3 で変異注入により実測——
 * `FIELD_OVERFLOW` 側だけ書式を変えても緑のままだった）。
 */
const PRODUCERS = [
  { file: "packages/tn5250/src/screen/field-validate.ts", count: 1, what: "型・コードページの拒否（`where()`）" },
  // **2 か所**: `FIELD_PROTECTED` と、D5 で足した `FIELD_OVERFLOW`
  { file: "packages/tn5250/src/screen/buffer.ts", count: 2, what: "5250 の FIELD_PROTECTED / FIELD_OVERFLOW" },
  { file: "packages/tn3270/src/session/session.ts", count: 1, what: "3270 の FIELD_PROTECTED" },
  { file: "packages/server/src/tn3270-adapt.ts", count: 1, what: "3270 の欄解決（server 側）" },
  // D5 が足したもう 1 つ（DBCS 欄の桁あふれ）
  { file: "packages/tn5250/src/session/session.ts", count: 1, what: "DBCS 欄の桁あふれ（D5 で追加）" }
];

/**
 * `field at (${a},${b})` の埋め込み——変数名は問わない。
 *
 * **空白を許さない**。`fieldAtOf` の実行時の正規表現は `/field at \((\d+),(\d+)\)/` で
 * カンマの後ろに空白を許さないので、走査側が `\s*` を許していると
 * `` `field at (${row}, ${col})` `` への変更が**走査は緑のまま実行時だけ拾えなくなる**
 * （review ラウンド 4 で実測）。値を外した結果**位置が唯一の手掛かり**なので、
 * ここが緩いと通知は黙って見出しだけに退化する。
 */
const TEMPLATE = /field at \(\$\{[^}]+\},\$\{[^}]+\}\)/u;

/**
 * **コメントを落としてから見る。** 同じ書式は JSDoc の中にも書いてある
 * （`field-validate.ts` の `where()` の説明が `buffer.ts` の形を引いている）ので、
 * 素で走査すると**実装を書き換えてもコメントが当たって緑のまま**になる
 * ——実際に変異注入で素通りした。
 *
 * **落とすのは `source-scan.ts` の `code()`**（同ファイルが「**複製しないこと**」と明記し、
 * `20260908-session-lifetime-rules-fold` D16 が「正規表現の重ね掛けでコメントを消すと
 * 文字列・テンプレート中のコメント記号を開始と誤読して領域ごと消える」を 3 度踏んだと記録している）。
 * 最初はここで自前の正規表現を書いており、**行末コメントを落とせず偽緑になる**ことを
 * review で実測された（`const x = 1; // \`field at (${row},${col})\`` が当たってしまう）。
 */

describe("`field at (行,桁)` は生産者と web-ui の正規表現の契約", () => {
  for (const { file, count, what } of PRODUCERS) {
    it(`${what} が書式を保っている（${file} / ${count} か所）`, () => {
      const src = code(readFileSync(join(root, file), "utf8"));
      const hits = src.match(new RegExp(TEMPLATE.source, "gu"))?.length ?? 0;
      expect(
        hits,
        `${file} の \`field at (\${row},\${col})\` が ${count} か所でない（${hits} か所）。` +
          "書式を変えたなら `opMessages.ts` の `fieldAtOf` も直すこと。" +
          "**足したなら count も増やすこと**——数で見ていないと片方だけ書き換えても素通りする"
      ).toBe(count);
    });
  }

  it("その書式で作った文言から、web-ui が位置を取り出せる", () => {
    // 生産者が実際に作る形（変数を実値に置いたもの）を通す
    for (const message of [
      "field at (20,7) accepts digits only",
      "field at (20,7) accepts alphabetic characters only",
      "field at (20,7) accepts double-byte characters only",
      "field at (20,7) cannot hold characters outside CCSID 37",
      "field at (20,7) is protected",
      "field at (20,7) accepts at most 10 characters",
      "field at (20,7) accepts at most 20 bytes"
    ]) {
      expect(wsErrorNotice("FIELD_TYPE", message), message).toContain(fieldAtLabel(20, 7));
    }
  });

  it("1 桁・3 桁の位置も拾う（24x80 の外も含む）", () => {
    expect(wsErrorNotice("FIELD_TYPE", "field at (1,1) accepts digits only")).toContain(
      "1 行 1 桁の欄"
    );
    expect(wsErrorNotice("FIELD_TYPE", "field at (27,132) accepts digits only")).toContain(
      "27 行 132 桁の欄"
    );
  });
});
