/**
 * 画面スナップショットの公開型。
 *
 * **`@ts5250/tn5250` の `screen/types.ts` と意図的に同じ形にしてある**（design D4）。
 * tn5250 に依存できないので共有はできないが、形を揃えておけば
 * 将来 web-ui が両方を描くときに `@ts5250/base` へ括る余地が残る。
 *
 * 3270 のバッファ構造は実測で確かめた（research F5）:
 * **フィールド属性は 1 桁を占め、DBCS 1 文字は 2 桁、SO/SI もそれぞれ 1 桁**。
 * `CellKind` はその桁の性格をそのまま表す。
 */

export type ScreenColor =
  | "default"
  | "black"
  | "blue"
  | "red"
  | "pink"
  | "green"
  | "turquoise"
  | "yellow"
  | "white";

/**
 * セルの種類。
 *
 * - `attr` … フィールド属性が置かれた桁（文字は空白として描く）
 * - `dbcs-lead` / `dbcs-tail` … DBCS 1 文字が占める 2 桁。`char` は lead 側にだけ入る
 * - `so` / `si` … DBCS 区間の切り替え（**画面上も 1 桁ぶん空く**。実測）
 */
export type CellKind = "sbcs" | "dbcs-lead" | "dbcs-tail" | "so" | "si" | "attr";

export interface Cell {
  /** 表示文字 1 文字。`attr` / `so` / `si` / `dbcs-tail` と非表示欄は " " */
  char: string;
  kind: CellKind;
  color: ScreenColor;
  /**
   * **背景色**（`XA.BACKGROUND`）。指定が無ければ `default`。
   * 3279 の拡張属性で、実際に使うホストは多くないが**応答モードで返す必要がある**ので持っている。
   */
  background: ScreenColor;
  intensified: boolean;
  reverse: boolean;
  underline: boolean;
  blink: boolean;
  /** 非表示欄（パスワード等）。`char` は " " になる */
  nonDisplay: boolean;
  /** SBCS セルの生 EBCDIC バイト（照合・再解釈のため。制御桁は undefined） */
  rawByte?: number;
}

export interface Field {
  /** snapshot 時点の連番（1 始まり・画面順） */
  index: number;
  /** 属性桁の位置（1 始まり）。**フィールドの中身はこの次の桁から** */
  attrRow: number;
  attrCol: number;
  /** 中身の先頭（属性桁の次の桁。1 始まり） */
  row: number;
  col: number;
  /** 中身の桁数（属性桁を含まない） */
  length: number;
  protected: boolean;
  numeric: boolean;
  /**
   * 自動スキップ欄（保護＋数字）。カーソルが飛ばす。
   * 実測で `0xF0` が `protected,skip` と復号されることを確認済み
   */
  autoSkip: boolean;
  /** 非表示（パスワード等） */
  hidden: boolean;
  intensified: boolean;
  /** MDT。入力があった欄に立つ */
  modified: boolean;
  /** 中身のテキスト（末尾の空白・NUL は落とさない。桁位置を保つため） */
  value: string;
}

export interface ScreenSnapshot {
  /** 現在有効なサイズ。**EW は標準 24x80、EWA は代替**（spec D5） */
  rows: number;
  cols: number;
  /** 代替サイズで動作中か */
  alternate: boolean;
  cursor: { row: number; col: number };
  cells: Cell[][];
  fields: Field[];
  /** キーボードがロックされているか（WCC の restore で解ける） */
  keyboardLocked: boolean;
  /**
   * 属性桁が 1 つも無い画面（非フォーマット画面）。
   * 全体が 1 つの非保護領域として扱われる
   */
  unformatted: boolean;
}
