/**
 * 端末タイプ名の組み立てと、モデルごとの画面サイズ（spec D5）。
 *
 * 出典は **RFC 1576**（直読・research F3）:
 *
 * > The -2 following 3278 designates the alternate screen size. 3270 terminals have the ability
 * > to switch between the standard (24x80) screen size and an alternate screen size.
 * > Model -2 is 24x80 which is the same as the standard size. Model -3 is 32x80,
 * > model -4 is 43x80 and model -5 is 27x132.
 * >
 * > Appending the two character string "-E" … signifies that the terminal is capable of
 * > handling 3270 extended data stream …
 * >
 * > The 3279 series of terminals is capable of extended attributes while the 3278 series is not.
 *
 * **標準サイズは常に 24x80**。モデル番号が指定するのは**代替サイズ**である
 * （`Erase/Write` は標準・`Erase/Write Alternate` は代替で書く）。
 */

/** 3270 のモデル番号。代替サイズを決める */
export type Model3270 = 2 | 3 | 4 | 5;

/** 端末系列。3279 は拡張属性対応、3278 は非対応（RFC 1576） */
export type TerminalFamily = "3278" | "3279";

/** 標準（基本）画面サイズ。モデルによらず常に 24x80 */
export const PRIMARY_SIZE = { rows: 24, cols: 80 } as const;

/** モデル番号 → 代替画面サイズ（RFC 1576） */
export const ALTERNATE_SIZE: Readonly<Record<Model3270, { rows: number; cols: number }>> = {
  2: { rows: 24, cols: 80 }, // 標準と同じ
  3: { rows: 32, cols: 80 },
  4: { rows: 43, cols: 80 },
  5: { rows: 27, cols: 132 }
};

export interface TerminalTypeOptions {
  model?: Model3270;
  family?: TerminalFamily;
  /** 拡張データストリーム（構造化フィールド）対応を申告する `-E` */
  extended?: boolean;
  /**
   * 装置名（LU 名）。**端末タイプ文字列に `@<値>` を付けて申告する**。
   *
   * 基本 TN3270 には LU 指定の仕組みが無いが、この慣行で装置を選べる
   * （research F1 実測: `IBM-3279-2-E@03C0` で TK4- の TCAM 端末に繋がる。
   * 存在しない装置なら Hercules が `HHC01030I Connection rejected, device … unavailable` を返す）。
   */
  deviceName?: string;
}

/**
 * 端末タイプ文字列を組み立てる。
 *
 * 形式: `IBM-<family>-<model>[-E][@<deviceName>]`
 * 例: `IBM-3279-2-E` / `IBM-3278-4` / `IBM-3279-2-E@03C0`
 */
export function terminalTypeFor(opts: TerminalTypeOptions = {}): string {
  const family = opts.family ?? "3279";
  const model = opts.model ?? 2;
  const extended = opts.extended ?? true;
  const base = `IBM-${family}-${model}${extended ? "-E" : ""}`;
  return opts.deviceName ? `${base}@${opts.deviceName}` : base;
}

/** そのモデルの代替サイズ */
export function alternateSizeFor(model: Model3270 = 2): { rows: number; cols: number } {
  return ALTERNATE_SIZE[model];
}
