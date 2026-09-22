import { isRawSentinel, sentinelByte } from "@ts5250/tn5250/browser";

/**
 * **Field− でゾーンを D にした最終桁の見え方**（`20260921-field-minus-zone-d` の節目の独立点検の指摘）。
 *
 * 数値専用の欄の Field− は最終桁のバイトを 0xD0〜0xD9 にして送る（`fieldEdit.fieldSign`）。値の中ではセンチネル（生のバイト）で運ぶので、
 * 表示はそのバイトをコードページの字にする——ACS `PS5250.processFieldPlusMinusAndExit` も `TextPlane[n2] = codepage.sb2uni(s2)` で
 * `}`・`J`〜`R` を画面に出す。~~センチネルなので空白に見える（web-ui はコードページの表を持たない。D2）~~ は構造の都合だった。
 *
 * 字は当 PJ が扱う CCSID（37・273・290・1027 と、それを SBCS 部に持つ 930・939・1399・931・5026・5035）で 0xD1〜0xD9 が `J`〜`R`、
 * 0xD0 が 273 だけ `ü`・他は `}`（`@ts5250/ebcdic` の変換表と一致することを `zone-digit.test.ts` が確かめる）。
 * ブラウザにはこの 10 字だけを持つ——変換表（`…/codec`）を持ち込むと DBCS 部ごとバンドルが膨らむ
 */
export function zoneDigitChar(byte: number, ccsid: number | undefined): string | undefined {
  if (byte < 0xd0 || byte > 0xd9) return undefined;
  if (byte === 0xd0) return ccsid === 273 ? "ü" : "}";
  return String.fromCharCode(0x4a + (byte - 0xd1)); // J〜R
}

/** センチネルを表示用の字にする。ゾーン D の桁は字で、それ以外（属性・Dup 等）は空白 1 桁（制御コードを見せない） */
export function showSentinels(s: string, ccsid: number | undefined): string {
  let out = "";
  for (const ch of s) out += isRawSentinel(ch) ? (zoneDigitChar(sentinelByte(ch), ccsid) ?? " ") : ch;
  return out;
}
