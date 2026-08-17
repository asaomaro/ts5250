import { As400Error } from "@ts5250/base";
import type { CommandParam, CommandTemplate } from "./command-template.js";

/**
 * **テンプレートから CL コマンド文字列を組み立てる。純関数**（ホストに触らない）。
 *
 * `CommandConnection.run()` は文字列を投げるだけなので、間違いは**実行するまで分からない**。
 * ここで**打つ前に**言い切れることを全部言う——知らないキーワード・必須の抜け・
 * 許されない値・桁溢れ。そして**引用を機械にやらせる**。
 *
 * > 引用を手で書くのは事故のもとで、このリポジトリでも踏んでいる
 * > （`scripts/build-empsfl-osaka.mjs` の「SO/SI が引用符の入れ子を壊す」）。
 */

/** 1 パラメータに渡せる値。配列は繰り返し（`KWD(A B C)`） */
export type CommandValue = string | number | readonly (string | number)[];

export interface BuildOptions {
  /**
   * **テンプレートに無いキーワードを通す**（既定 false）。
   * 定義より新しいシステムで動かすとき等の逃げ道で、**検証はされない**。
   */
  allowUnknown?: boolean;
}

/**
 * 値を CL の書き方に直す。
 *
 * | 値 | 出力 |
 * |---|---|
 * | `*PROD` のような `*` 始まり | そのまま（特殊値） |
 * | 英数字と `.` `_` `/` `#` `$` `@` `-` だけで**小文字を含まない** | そのまま |
 * | それ以外（空白・小文字・記号） | `'…'` で囲む |
 * | 値の中の `'` | `''` に二重化 |
 *
 * **小文字を引用する**のが肝心——CL は引用しない値を**大文字に畳む**ので、
 * `TEXT(abc)` は `ABC` になってしまう。打った通りに入れたいなら囲むしかない。
 */
export function formatValue(value: string | number): string {
  const s = String(value);
  if (s.length === 0) return "''";
  if (s.startsWith("*") && /^\*[A-Z0-9]+$/.test(s)) return s; // 特殊値
  if (/^[A-Z0-9.\-_/#$@]+$/.test(s)) return s; // 名前・数値はそのまま
  return `'${s.replaceAll("'", "''")}'`;
}

/** そのキーワードの定義を引く（大文字小文字を無視する） */
function paramOf(tpl: CommandTemplate, keyword: string): CommandParam | undefined {
  const k = keyword.toUpperCase();
  return tpl.parameters.find((p) => p.keyword === k);
}

function checkOne(p: CommandParam, raw: string | number): void {
  const s = String(raw);
  if (p.restricted && p.specialValues.length > 0) {
    const up = s.toUpperCase();
    if (!p.specialValues.some((v) => v.toUpperCase() === up)) {
      throw new As400Error(
        "FIELD_TYPE",
        `${p.keyword} accepts only ${p.specialValues.join(" / ")} (got ${s})`
      );
    }
  }
  // **引用符を除いた中身**の長さで見る。`Len` は値そのものの桁数
  if (p.length !== undefined && p.length > 0 && s.length > p.length && !s.startsWith("*")) {
    throw new As400Error(
      "FIELD_OVERFLOW",
      `${p.keyword} accepts up to ${p.length} characters (got ${s.length})`
    );
  }
}

/**
 * コマンド文字列を組み立てる。
 *
 * 値の並びは**テンプレートの順**にする（`PosNbr` ではなく定義の並び）——
 * キーワードを書くので順序に意味は無いが、**同じ入力からは同じ文字列**が出るようにしておくと
 * 記録・比較・再現が楽になる。
 */
export function buildCommand(
  tpl: CommandTemplate,
  values: Readonly<Record<string, CommandValue | undefined>>,
  opts: BuildOptions = {}
): string {
  const given = new Map<string, CommandValue>();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    const p = paramOf(tpl, key);
    if (p === undefined && opts.allowUnknown !== true) {
      throw new As400Error(
        "FIELD_NOT_FOUND",
        `${tpl.name} has no parameter ${key} (has ${tpl.parameters.map((x) => x.keyword).join(", ")})`
      );
    }
    given.set(key, v);
  }

  // **必須の抜けは打つ前に**。ホストに任せると CPF0001 だけが返って原因が分からない
  for (const p of tpl.parameters) {
    if (p.required && !given.has(p.keyword)) {
      throw new As400Error("CONFIG_ERROR", `${tpl.name} requires ${p.keyword}${p.prompt ? ` (${p.prompt})` : ""}`);
    }
  }

  const parts: string[] = [tpl.name];
  const emit = (keyword: string, value: CommandValue): void => {
    const p = paramOf(tpl, keyword);
    const list = Array.isArray(value) ? value : [value as string | number];
    if (p !== undefined) {
      if (list.length > p.maxValues) {
        throw new As400Error(
          "FIELD_OVERFLOW",
          `${p.keyword} accepts up to ${p.maxValues} value(s) (got ${list.length})`
        );
      }
      for (const v of list) checkOne(p, v);
    }
    parts.push(`${keyword}(${list.map((v) => formatValue(v)).join(" ")})`);
  };

  // テンプレートの並びで出し、テンプレートに無いもの（allowUnknown）は後ろへ
  for (const p of tpl.parameters) {
    const v = given.get(p.keyword);
    if (v !== undefined) emit(p.keyword, v);
  }
  for (const [k, v] of given) {
    if (paramOf(tpl, k) === undefined) emit(k, v);
  }
  return parts.join(" ");
}
