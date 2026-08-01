/**
 * フィールド値の文字列の中で、**Unicode に落とせないバイトを identity を保ったまま運ぶ**ための
 * センチネル表現。私用面 U+E000+byte を 1 文字として使う。
 *
 * 対象は 2 種類ある。
 *
 * 1. **埋め込み画面属性（0x20–0x3F）**
 *    SEU の色付きソースのように入力欄データに属性バイトが埋め込まれる場合、値の中で属性を
 *    「ただの空白」にすると、編集で桁は動くのに色と送信バイトが元の桁に残り、送信でソースが
 *    壊れ得た。センチネルにすれば文字列編集で属性も一緒に動き（前を削除→左へ／前に挿入→右へ）、
 *    色も追従し、送信でも正しい桁に戻る。
 *
 * 2. **表示できない SBCS バイト**
 *    EBCDIC の SBCS 表にはマップの無いバイトがあり、デコードすると U+FFFD になる。そのまま
 *    値に載せると、その欄を編集して送信した時点で元のバイトが失われ SUB（0x3F）に化ける
 *    （日本語機の実データで発生）。センチネルで生バイトを持てば、編集しても送信で元のバイトに戻る。
 *
 * - 完全可逆（バイト値をそのまま保持。reverse/underline 等も失わない）
 * - 表示は空白 1 桁（描画側で `stripSentinels` して見た目は従来どおり）
 * - 私用面なので実ソース文字（EBCDIC 由来）と衝突しない
 *
 * 属性は色の解釈が要るので `isAttrSentinel`（0x20–0x3F）で別に判定できるようにしてある。
 * 送信側はどちらも「生バイトをそのまま書く」だけなので `isRawSentinel` の一択でよい。
 */

/** センチネルの基点。バイト b(0x00–0xFF) → U+E000+b */
const BASE = 0xe000;
/** 埋め込み画面属性の範囲 */
const ATTR_LOW = BASE + 0x20;
const ATTR_HIGH = BASE + 0x3f;

/** 属性バイト(0x20–0x3F)をセンチネル文字にする */
export function attrSentinel(byte: number): string {
  return String.fromCharCode(BASE + byte);
}

/** 生バイト(0x00–0xFF)をセンチネル文字にする（表示できない SBCS バイト用） */
export function rawSentinel(byte: number): string {
  return String.fromCharCode(BASE + (byte & 0xff));
}

/** その 1 文字が**属性**センチネルか（色の解釈が要るのはこれだけ） */
export function isAttrSentinel(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= ATTR_LOW && c <= ATTR_HIGH;
}

/** その 1 文字が生バイトを運ぶセンチネルか（属性センチネルを含む） */
export function isRawSentinel(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= BASE && c <= BASE + 0xff;
}

/** センチネル文字から元のバイトを取り出す */
export function sentinelByte(ch: string): number {
  return ch.charCodeAt(0) - BASE;
}

/** センチネル文字から元の属性バイトを取り出す（`sentinelByte` の別名。属性用の呼び名） */
export function attrSentinelByte(ch: string): number {
  return sentinelByte(ch);
}

/** 文字列中のセンチネルを空白へ置換する（表示用）。正規表現の私用面リテラルを避け 1 文字ずつ判定する */
export function stripSentinels(s: string): string {
  let out = "";
  for (const ch of s) out += isRawSentinel(ch) ? " " : ch;
  return out;
}
