import { SO_MARK, SI_MARK } from "../../src/composables/fieldValidate.js";

/**
 * **O 欄の値をセルの記法で書く**（`20260928-o-field-cells`）: `{` を SO の印、`}` を SI の印に置き換える。
 * O 欄（継続でない）の編集の値は SO/SI を印として持つので、期待値は ACS のセルの並びのまま書く（例: `o("{あ}X")`）
 */
export const o = (s: string): string => s.replace(/\{/g, SO_MARK).replace(/\}/g, SI_MARK);
