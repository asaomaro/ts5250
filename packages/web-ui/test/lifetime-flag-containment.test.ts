import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { code } from "./source-scan.js";

/**
 * **セッション寿命の判定が散らばらないことを固定する**（クライアント側。
 * `20260908-session-lifetime-rules-fold` AC2）。
 *
 * サーバー側（`packages/server/test/lifetime-flag-containment.test.ts`）と同じ形。
 * **こちらには lint が効かない**——`packages/web-ui/**` は `eslint.config.js` の
 * `ignores` に丸ごと入っているので、走査テストと**型の封じ込め**（`connected` /
 * `reconnect` / `reconnectFailed` を読み取り専用アクセサにしてあるので代入が型エラーになる）
 * の 2 つがこのモジュールを守る仕組みのすべて。
 *
 * 型のほうはテストにも効く（`tsconfig.test.json` が `test/` を型検査に含める）。
 */
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** `src` の全 `.ts` / `.vue` を（ファイル名, 中身）で返す */
function sources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".vue"))
        out.push({ name: relative(srcDir, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") });
    }
  };
  walk(srcDir);
  return out;
}


describe("セッション寿命の判定は 1 か所に閉じている（クライアント）", () => {
  /**
   * **畳んで消えたもの。** 復活したら、`link` / `Attempt` の外に状態を持ち出したということ。
   *
   * `attachedOnly` / `endedByHost` は `link` と `resumability` に、
   * `pendingResumes` / `reconnectTimers` は `attempts`（`Attempt`）に畳んだ。
   */
  it("旧フラグ・旧 Map は src のどこにも無い", () => {
    const gone = ["attachedOnly", "endedByHost", "pendingResumes", "reconnectTimers"];
    const offenders = sources().flatMap(({ name, text }) =>
      gone.filter((flag) => new RegExp(`\\b${flag}\\b`).test(code(text))).map((flag) => `${name}: ${flag}`)
    );
    expect(offenders).toEqual([]);
  });

  /**
   * **`link` へ書いてよいのは store の遷移関数だけ。**
   *
   * 畳み込み前は 9 箇所が `connected` へ直接書いており（HEAD `90f5636f` 実測。
   * このテストが数える `.link =` は 4 フィールド分なので、同じ数え方なら 12 箇所——
   * `stores/sessions.ts` の同趣旨のコメントと同じ内訳）、「どこで切断が記録されたか」を
   * 追うのに全箇所を読む必要があった。書き込みを 1 か所に寄せたことが畳み込みの本体なので、
   * ここが増えたら元に戻っている。
   */
  it("link への代入は stores/sessions.ts の中だけ", () => {
    const offenders = sources()
      .filter(({ name }) => name !== "stores/sessions.ts")
      .flatMap(({ name, text }) => ([...code(text).matchAll(/\.link\s*=/g)].length > 0 ? [name] : []));
    expect(offenders).toEqual([]);
  });

  /**
   * **繋ぎ直しの適性を読むのは、それを組み立てる場所だけ。**
   * 表示側が読み始めたら、それは「門をもう 1 つ生やした」ということ。
   *
   * design は「`session-controller.ts` の外で読まれない」と書くが、`stores/sessions.ts` は
   * **欄そのものを宣言している**（`SessionStateInit.resumability`）ので読みでは無い——
   * ここが分岐に使い始めたら違反だが、それは走査では見分けられないので型と review に委ねる。
   */
  it("resumability を読むのは session-controller.ts / stores/sessions.ts だけ", () => {
    // 規則の側（`session-link.ts`）は入れない——型は `Resumability`（大文字）で、本文に
    // 小文字の出現は無い。入れておくと「規則が読み始めた」変化を取り逃がす
    const inside = new Set(["session-controller.ts", "stores/sessions.ts"]);
    const offenders = sources()
      .filter(({ name }) => !inside.has(name))
      .flatMap(({ name, text }) => (/\bresumability\b/.test(code(text)) ? [name] : []));
    expect(offenders).toEqual([]);
  });

  /**
   * **試行の記録は `session-controller.ts` の外に出さない。**
   * `attempts` が「いまの試行」の唯一の真実で、`isCurrentAttempt` がその答えを返す。
   */
  it("attempts を触るのは session-controller.ts だけ", () => {
    const offenders = sources()
      .filter(({ name }) => name !== "session-controller.ts")
      .flatMap(({ name, text }) => (/\battempts\b/.test(code(text)) ? [name] : []));
    expect(offenders).toEqual([]);
  });

  /**
   * **`settled` は「畳んで消えたもの」ではなく「畳んだ先に閉じ込めたもの」。**
   *
   * design「AC2 の詳細」は 5 つとも「0 件」で縛ると書いているが、これだけは `Attempt` の欄
   * として正当に残る（`isCurrentAttempt` が読む）。だから**在ってよい場所を固定する**形に
   * 変えた（D15。`viewers` を対象から外した D14 と同じ扱い）。
   *
   * **HEAD でもこのテストは緑**（当時 `settled` は `session-controller.ts` の局所変数 1 か所）。
   * ここが守るのは過去との差ではなく、**今後この 2 ファイルの外へ広がらないこと**。
   */
  it("settled を読み書きするのは session-link.ts / session-controller.ts だけ", () => {
    const inside = new Set(["session-link.ts", "session-controller.ts"]);
    const offenders = sources()
      .filter(({ name }) => !inside.has(name))
      .flatMap(({ name, text }) => (/\bsettled\b/.test(code(text)) ? [name] : []));
    expect(offenders).toEqual([]);
  });
});
