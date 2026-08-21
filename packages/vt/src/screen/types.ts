/**
 * 画面のセルと属性。**利用側（web-ui）がそのまま描ける形**にする。
 */

/**
 * 色は 3 形態を保つ（spec D5）。
 *
 * **16 色を RGB に潰さない。** 潰すと利用側がテーマに合わせて色を決められなくなる
 * （AGENTS.md「既存クライアントの側が情報を捨てているなら、合わせない」）。
 * `indexed` の 0-15 は名前つき 16 色（0-7 が通常、8-15 が明色）、16-255 は 256 色の残り。
 */
export type VtColor =
  | { readonly kind: "default" }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };

export const DEFAULT_COLOR: VtColor = { kind: "default" };

/**
 * セルの見た目。**同じ見た目のセルは同じインスタンスを共有する**——
 * 24x80 ＋ スクロールバック 1,000 行で 86,400 セルあり、1 つずつ属性オブジェクトを持たせると
 * 効果が無いのに費用だけ掛かる。`SGR` が来たときだけ新しい `VtStyle` を作る。
 */
export interface VtStyle {
  readonly fg: VtColor;
  readonly bg: VtColor;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  /** 前景と背景を入れ替えて描く（`SGR 7`） */
  readonly reverse: boolean;
  /** 描かない（`SGR 8`）。**文字は保持する**——選択してコピーはできる */
  readonly hidden: boolean;
  readonly strike: boolean;
}

export const DEFAULT_STYLE: VtStyle = Object.freeze({
  fg: DEFAULT_COLOR,
  bg: DEFAULT_COLOR,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  reverse: false,
  hidden: false,
  strike: false
});

/**
 * 1 桁ぶん。
 *
 * `width` の意味（spec D6）:
 * - `1` … 半角。ふつうのセル
 * - `2` … **全角の左半分**。`char` はここに入る
 * - `0` … **全角の右半分（継続セル）**。`char` は空文字
 */
export interface VtCell {
  readonly char: string;
  readonly style: VtStyle;
  readonly width: 0 | 1 | 2;
}

export const blankCell = (style: VtStyle): VtCell => ({ char: " ", style, width: 1 });

/** 画面の写し。**行は上から順、スクロールバックは古い順** */
export interface VtSnapshot {
  readonly rows: number;
  readonly cols: number;
  readonly cursor: { readonly row: number; readonly col: number; readonly visible: boolean };
  /** 現在表示している画面（主画面か代替画面か） */
  readonly cells: readonly (readonly VtCell[])[];
  /** 主画面から流れ出た行（代替画面のぶんは入らない。spec D7） */
  readonly scrollback: readonly (readonly VtCell[])[];
  /** 代替画面を表示中か */
  readonly alternate: boolean;
  /** `OSC 0/2` で設定されたウィンドウタイトル */
  readonly title: string;
}
