/**
 * CCSID 300（日本語 DBCS）の Unicode 割り当てのうち、**規格寄りの表と既存クライアントで
 * 食い違う分**を 1 箇所にまとめる。純 DBCS（GRAPHIC 列）と混在 CCSID（5250 画面の 930/939）の
 * 両方が同じ割り当てを使うための単一の出所。
 *
 * 中身は日本語エンコーディングで有名な**波ダッシュ・全角チルダ問題**そのもの。
 * ICU の ucm も JTOpen の ConvTable16684 も Unicode 規格寄り（U+2212 / U+301C …）に割り当てるが、
 * ACS / jt400（ConvTable300）は**全角形**（U+FF0D / U+FF5E …）を返す。
 *
 * **本プロジェクトは ACS の代替なので ACS と同じ結果を正とする**（AGENTS.md「規格どおりより
 * 既存クライアントと同じ挙動」）。表示上も差が出る——全角形は East Asian Width が Fullwidth で
 * どのフォントでも 2 桁、規格寄りの U+2212 等は Ambiguous で欧文フォントが 1 桁に描くため、
 * DBCS のはずの文字が半角で出て以降の桁が左へずれる（PDM の F1 ヘルプ「オプション−ヘルプ」で実測）。
 *
 * 逆方向（Unicode → バイト）はどちらの符号位置からも同じバイト対へ寄るので、往復は保たれる。
 */

/** EBCDIC 2 バイト → Unicode の差分（原典 ConvTable300 の toUnicodeArray300_ に対応） */
export const CCSID300_TO_UNICODE: ReadonlyArray<readonly [number, number]> = [
  [0x4260, 0xff0d], // 16684: U+2212 MINUS SIGN          → U+FF0D FULLWIDTH HYPHEN-MINUS
  [0x426a, 0xffe4], // 16684: U+00A6 BROKEN BAR          → U+FFE4 FULLWIDTH BROKEN BAR
  [0x43a1, 0xff5e], // 16684: U+301C WAVE DASH           → U+FF5E FULLWIDTH TILDE
  [0x444a, 0x2015], // 16684: U+2014 EM DASH             → U+2015 HORIZONTAL BAR
  [0x447c, 0x2225] // 16684: U+2016 DOUBLE VERTICAL LINE → U+2225 PARALLEL TO
];

/** 逆方向（Unicode → バイト）の差分。原典 ConvTable300 の fromUnicodeArray300_ に対応 */
export const CCSID300_FROM_UNICODE: ReadonlyArray<readonly [number, number]> = [
  [0x2015, 0x444a],
  [0x2225, 0x447c],
  [0x525d, 0x5481],
  [0x5c5b, 0x5443],
  [0x7c1e, 0x54ca],
  [0x87ec, 0x53e8],
  [0x9a52, 0x53da],
  [0xff0d, 0x4260],
  [0xff5e, 0x43a1],
  [0xffe4, 0x426a]
];
