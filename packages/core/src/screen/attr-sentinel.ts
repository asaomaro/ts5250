/**
 * 埋め込み画面属性（0x20–0x3F）を、フィールド値の文字列の中で**識別可能な1文字**として運ぶための
 * センチネル表現。
 *
 * SEU の色付きソースのように入力欄データに属性バイトが埋め込まれる場合、値の中で属性を
 * 「ただの空白」にすると（従来）、編集で桁は動くのに色と送信バイトが元の桁に残り、
 * 送信でソースが壊れ得た。属性バイトを**私用面のセンチネル文字**（U+E020–U+E03F）として持てば、
 * 文字列編集で属性も一緒に動き（前を削除→左へ／前に挿入→右へ）、色も追従し、送信でも正しい桁に戻る。
 *
 * - 完全可逆（バイト値をそのまま保持。reverse/underline 等も失わない）
 * - 表示は空白1桁（描画側で `stripAttrSentinels` して見た目は従来どおり）
 * - 私用面なので実ソース文字（EBCDIC 由来）と衝突しない
 */

/** センチネルの基点。属性バイト b(0x20–0x3F) → U+E000+b */
const BASE = 0xe000;
const LOW = BASE + 0x20;
const HIGH = BASE + 0x3f;

/** 属性バイト(0x20–0x3F)をセンチネル文字にする */
export function attrSentinel(byte: number): string {
  return String.fromCharCode(BASE + byte);
}

/** その1文字がセンチネルか */
export function isAttrSentinel(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= LOW && c <= HIGH;
}

/** センチネル文字から元の属性バイトを取り出す */
export function attrSentinelByte(ch: string): number {
  return ch.charCodeAt(0) - BASE;
}

/** 文字列中のセンチネルを空白へ置換する（表示用）。正規表現の私用面リテラルを避け1文字ずつ判定する */
export function stripAttrSentinels(s: string): string {
  let out = "";
  for (const ch of s) out += isAttrSentinel(ch) ? " " : ch;
  return out;
}
