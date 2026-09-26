import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// jsdom 環境では`import.meta.url`がファイルの URL にならないので、パッケージ dir 基準の相対パスで引く
// （`chrome-marks.test.ts`と同じ。リポジトリのルートから回した場合にも効く）
const at = (rel: string) => (existsSync(rel) ? rel : `packages/web-ui/${rel}`);
const read = (rel: string) => readFileSync(at(rel), "utf8");
/** リポジトリ相対のパスを、今の cwd から引ける形にする */
const fromRepo = (rel: string) => (existsSync("scripts/gen-icons.mjs") ? `../../${rel}` : rel);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * アプリのマーク（ファビコン・Electron の png / ico・VSCode 拡張とファイルのアイコン）。
 * すべて`scripts/gen-icons.mjs`の1つの定義から作る。バイナリなので、色を直して作り直し忘れても
 * 見比べるまで気づけない——ここで機械的に落とす（`20260924-vscode-extension` D25）。
 * **描き直しはしない**——生成が書く`icons.stamp.json`（スクリプトと各出力の sha256）と突き合わせる
 * （描き直すと並列実行で1分を超え、他のテストをタイムアウトさせた）
 */
describe("アプリのアイコン", () => {
  const stamp = JSON.parse(read("scripts/icons.stamp.json")) as { script: string; files: Record<string, string> };

  it("生成スクリプトを変えたら作り直してある（npm run gen:icons）", () => {
    expect(sha256(at("scripts/gen-icons.mjs"))).toBe(stamp.script);
  });

  it("出力はすべて生成したときのまま（手で差し替えていない）。Electron の png/ico・VSCode のアイコンも含む", () => {
    expect(Object.keys(stamp.files).sort()).toEqual([
      "electron/build/icon.ico",
      "electron/build/icon.png",
      "packages/web-ui/public/apple-touch-icon.png",
      "packages/web-ui/public/favicon.ico",
      "packages/web-ui/public/favicon.svg",
      "vscode-extension/icon.png"
    ]);
    for (const [rel, hash] of Object.entries(stamp.files)) expect(sha256(fromRepo(rel)), rel).toBe(hash);
  });
  /**
   * 5250端末ソフトなので、マークは既定の端末配色「5250 端末 クラシック」の色で描く（利用者の要望）。
   * 地は --crt、ブロックカーソル（■）は --t-green、`T` は --t-pink、■の上の `S` は地の色で抜く（D29）
   */
  it("マークの色は「5250 端末 クラシック」の地（--crt）・緑（--t-green）・ピンク（--t-pink）", () => {
    const css = read("src/styles.css");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root)?.[1]?.toLowerCase();
    const svg = read("public/favicon.svg");
    expect([token("--crt"), token("--t-green"), token("--t-pink")]).toEqual(["#000000", "#00ff00", "#ff00ff"]);
    // 描く順序も見る: T（ピンク）→ ■（緑）→ S（地の色で抜く）
    const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(fills).toEqual([token("--crt"), token("--t-pink"), token("--t-green"), token("--crt")]);
  });
});
