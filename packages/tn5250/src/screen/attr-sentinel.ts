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

/**
 * センチネルの基点。バイト b(0x00–0xFF) → **U+DC00+b**（単独のローサロゲート）。
 *
 * **基本多言語面（BMP）の私用面 U+E000–U+F8FF は使えない。** そこは**外字**（ユーザー定義
 * 文字）の落ち先で、当方の DBCS 変換表がまるごと埋めている——実測で CCSID 930/939/1399/
 * 300/16684 の表が U+E000〜U+F83C の 6205 個を使い、**256 連続の空きが 1 つも無い**。
 * 930 の外字 0x6941〜0x6A40 はちょうど U+E000〜U+E0FF で、**旧基点と完全に重なっていた**。
 *
 * 【実機で分かった不具合】外字を含む DBCS 欄を編集して送ると、**外字 1 文字が生バイト 1 つ
 * （0x00）に化けて SO/SI ごと消える**（実機 IBM i 7.3・`TESTLIB/UDCPGM` で外字 ＋ `AB` を
 * 送ると、ホストは外字を失った値を受け取った）。web-ui は DBCS 欄を編集するとき値をセルから
 * 組み立て直す（`logicalFromCells`）ので、外字とセンチネルを見分けられなかった。
 *
 * **なぜ単独ローサロゲートか。**
 * - 変換表の落ち先と**構造的に衝突しない**（表が返すのは常に完全な文字＝スカラー値。
 *   単独サロゲートは「文字ではない」ので、どの符号化文字集合からも出てこない）。
 * - **1 コード単位で収まる**。桁の勘定（`slice` / `padEnd` / 欄長）はセンチネルを
 *   「1 桁」として数える前提で組んであり、第 15 面（サロゲート対＝2 コード単位）へ移すと
 *   その勘定が全部ずれる（実際に `inputScrollValue` の桁詰めが 1 桁ずれた）。
 * - Python の `surrogateescape`（PEP 383）と同じ手口で、**バイトを可逆に運ぶ**用途の定石。
 *
 * ⚠ **判定は必ず符号位置で行う**（`codePointAt`）。`for (const ch of s)` はサロゲート対を
 * 1 文字として返すので、CCSID 1399 の BMP 外漢字（実測 909 対。例 U+2000B）を
 * センチネルと取り違えない。**コード単位の添字 `s[i]` で判定してはいけない**——
 * BMP 外の文字の下位サロゲートを拾ってしまう。
 *
 * ⚠ 単独サロゲートは UTF-8 にできない。**外へ出す前に必ず落とすか置き換える**
 * （表示は `stripSentinels`、送信は生バイト、JSON は `JSON.stringify` が
 * `\udcXX` へ逃がすので往復できる）。
 */
const BASE = 0xdc00;
/** 埋め込み画面属性の範囲 */
const ATTR_LOW = BASE + 0x20;
const ATTR_HIGH = BASE + 0x3f;

/** 属性バイト(0x20–0x3F)をセンチネル文字にする */
export function attrSentinel(byte: number): string {
  return String.fromCodePoint(BASE + byte);
}

/** 生バイト(0x00–0xFF)をセンチネル文字にする（表示できない SBCS バイト用） */
export function rawSentinel(byte: number): string {
  return String.fromCodePoint(BASE + (byte & 0xff));
}

/** その 1 文字が**属性**センチネルか（色の解釈が要るのはこれだけ） */
export function isAttrSentinel(ch: string): boolean {
  const c = ch.codePointAt(0);
  return c !== undefined && c >= ATTR_LOW && c <= ATTR_HIGH;
}

/** その 1 文字が生バイトを運ぶセンチネルか（属性センチネルを含む） */
export function isRawSentinel(ch: string): boolean {
  const c = ch.codePointAt(0);
  return c !== undefined && c >= BASE && c <= BASE + 0xff;
}

/** センチネル文字から元のバイトを取り出す */
export function sentinelByte(ch: string): number {
  return (ch.codePointAt(0) ?? BASE) - BASE;
}

/** センチネル文字から元の属性バイトを取り出す（`sentinelByte` の別名。属性用の呼び名） */
export function attrSentinelByte(ch: string): number {
  return sentinelByte(ch);
}

/**
 * **継続した O 欄で、区間の間で割れた全角の半分**（前半は区間の最後の桁・後半は次の区間の頭の桁。ACS は SI が区間の最後の桁のときの全角の挿入で
 * 割って書く。実機 `scripts/acs-probe/cont-o-last-lead.txt`）を値の中の 1 文字で運ぶ。前半は字を運ぶ（第 16 面＋字）、後半は目印だけ（第 15 面の先頭）。
 * どちらも BMP 外の符号位置なので、センチネル（U+DC00〜）・通常の字と重ならず、桁は 1 つ（半角幅）として数えられる。字が BMP 外なら作れない（`undefined`）
 */
const SPLIT_LEAD_BASE = 0x100000;
const SPLIT_TAIL_CP = 0xf0000;
export function splitLead(ch: string): string | undefined {
  const c = ch.codePointAt(0);
  return c !== undefined && c <= 0xffff ? String.fromCodePoint(SPLIT_LEAD_BASE + c) : undefined;
}
export function isSplitLead(ch: string): boolean {
  const c = ch.codePointAt(0);
  return c !== undefined && c >= SPLIT_LEAD_BASE && c <= SPLIT_LEAD_BASE + 0xffff;
}
/** 割れた全角の前半が運ぶ字 */
export function splitLeadChar(ch: string): string {
  return String.fromCodePoint((ch.codePointAt(0) ?? SPLIT_LEAD_BASE) - SPLIT_LEAD_BASE);
}
/** 割れた全角の後半の目印 */
export const SPLIT_TAIL = String.fromCodePoint(SPLIT_TAIL_CP);
export const isSplitTail = (ch: string): boolean => ch.codePointAt(0) === SPLIT_TAIL_CP;

/**
 * **中身が入って届く非表示（伏せ字）の DBCS 欄の、触らない桁の目印**。値（中身）はブラウザへ出さない（`Field.value`・セルの字は空）ので、編集は「その桁の元の中身」を
 * 桁の番号つきの目印で持ち、保存のとき core が元の中身へ戻す（`ScreenBuffer.mergeKeep`）。ACS は伏せ字の欄の中身の上に上書きする（実機 `hidden-dbcs-content.txt`）。
 * 半角 1 桁の目印は第 15 面（桁の番号 0〜255）、全角の目印は BMP の私用領域の末尾（0xF700＋桁の番号。全角幅として数えられる）
 */
const KEEP_NARROW_BASE = 0xf0100;
const KEEP_WIDE_BASE = 0xf700;
export function keepNarrow(idx: number): string {
  return String.fromCodePoint(KEEP_NARROW_BASE + (idx & 0xff));
}
export function keepWide(idx: number): string {
  return String.fromCodePoint(KEEP_WIDE_BASE + (idx & 0xff));
}
/** 触らない桁の目印なら、その桁の番号と全角か */
export function keepIndex(ch: string): { idx: number; wide: boolean } | undefined {
  const c = ch.codePointAt(0);
  if (c === undefined) return undefined;
  if (c >= KEEP_NARROW_BASE && c <= KEEP_NARROW_BASE + 0xff) return { idx: c - KEEP_NARROW_BASE, wide: false };
  if (c >= KEEP_WIDE_BASE && c <= KEEP_WIDE_BASE + 0xff) return { idx: c - KEEP_WIDE_BASE, wide: true };
  return undefined;
}

/** 文字列中のセンチネルを空白へ置換する（表示用）。正規表現の私用面リテラルを避け 1 文字ずつ判定する */
export function stripSentinels(s: string): string {
  let out = "";
  for (const ch of s) out += isRawSentinel(ch) ? " " : ch;
  return out;
}
