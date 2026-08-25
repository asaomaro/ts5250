import type { Field } from "@ts5250/tn5250";

/**
 * **継続入力フィールド（EDTMSK 分割）の区間の並び**（先頭 → 最終）。単独欄は自分 1 つだけ。
 *
 * ホストは `EDTMSK` で割った欄を、区切り文字（`/` 等）を挟んだ複数の欄として送る
 * （`Field.continued` = "first"/"middle"/"last"）。ACS は並び全体を**1 つの入力欄**として扱うので、
 * 編集（`ScreenGrid`）も欄移動（`EmulatorPane`）も「どの区間がひとまとまりか」を知る必要がある。
 * **導出元は 1 か所**に置く——2 か所に書くと片方だけ直して挙動が食い違う。
 *
 * core の `ScreenBuffer.continuedRun` と同じ歩き方（区間は画面順で連続している前提）。
 */
export function continuedRunOf(fields: readonly Field[], f: Field): Field[] {
  if (f.continued === undefined) return [f];
  const ordered = [...fields].sort((a, b) => a.index - b.index);
  let i = ordered.findIndex((x) => x.index === f.index);
  if (i < 0) return [f];
  while (i > 0 && ordered[i]?.continued !== "first" && ordered[i - 1]?.continued !== undefined) i--;
  const run: Field[] = [];
  for (let j = i; j < ordered.length; j++) {
    const x = ordered[j];
    if (!x || x.continued === undefined) break;
    if (j > i && x.continued === "first") break; // 次の継続欄の先頭＝この並びは終わり
    run.push(x);
    if (x.continued === "last") break;
  }
  return run.length > 0 ? run : [f];
}

/**
 * **Tab の停止点になる区間か。** 並びの先頭区間だけが停止点で、中間・最終は止まらない
 * （ACS は並び全体で 1 つの欄なので、区切りごとに Tab が止まるのは実機と違う）。
 *
 * 単独欄（`continued` 無し）は当然そのまま停止点。
 */
export function isTabStopField(f: Field): boolean {
  return f.continued === undefined || f.continued === "first";
}
