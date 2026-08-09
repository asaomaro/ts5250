/**
 * `fontkit` の型宣言（`@types/fontkit` は無い）。
 *
 * **使う分だけ宣言する。** 全体を写すと本家の版と黙ってずれるので、
 * `pdf-font.ts` が実際に触る 4 つ（`openSync` / `fonts` / `postscriptName` /
 * `layout` / `hasGlyphForCodePoint`）に絞ってある。
 * fontkit は pdfkit の依存でもあるので実体は必ず入っている。
 */
declare module "fontkit" {
  export interface FontkitFace {
    readonly postscriptName: string;
    layout(text: string): { advanceWidth: number };
    hasGlyphForCodePoint?(codePoint: number): boolean;
  }
  /** `.ttc` は複数の書体を束ねる。単一フォントのときは `fonts` を持たない */
  export interface FontkitCollection {
    readonly fonts: FontkitFace[];
  }
  export function openSync(path: string): FontkitFace | FontkitCollection;
}
