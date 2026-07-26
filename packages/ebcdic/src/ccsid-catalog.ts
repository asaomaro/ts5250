/**
 * 手動で選べる文字コードの候補。
 *
 * **表を一切引き込まない**——UI（ブラウザ）が選択肢を組み立てるためだけの一覧なので、
 * `codec.js`（DBCS の巨大な表を同梱する）に依存させない。復号・符号化そのものは
 * `ccsid-text.ts` が行う（そちらは表を使う）。
 */

/**
 * 行末の流儀。
 *
 * EBCDIC のストリームファイルは行末に **0x15（復号すると U+0085 NEL）** を使うことがあり、
 * そのまま返すと `<textarea>` でもブラウザでも改行に見えない。
 * 復号時に `\n` へ正規化し、書き戻すときに元へ戻すためにどちらだったかを持ち回る。
 */
export type LineEnding = "lf" | "nel";

/**
 * 手動選択に出す候補。**実機で多い順**に並べる（research F4: 819 が最多、次いで 850・1208）。
 *
 * CCSID 850 は復号手段を持たないので出さない（`ccsid-text.ts` の冒頭を参照）。
 * `writable: false` は「読めるが書けない」＝保存に使えないもの。
 */
export const TEXT_CCSIDS: readonly { ccsid: number; label: string; writable: boolean }[] = [
  { ccsid: 1208, label: "1208 (UTF-8)", writable: true },
  { ccsid: 819, label: "819 (ISO 8859-1)", writable: true },
  { ccsid: 1200, label: "1200 (UTF-16BE)", writable: true },
  { ccsid: 37, label: "37 (EBCDIC 英語)", writable: true },
  { ccsid: 273, label: "273 (EBCDIC ドイツ語)", writable: true },
  { ccsid: 1399, label: "1399 (EBCDIC 日本語・混在)", writable: true },
  { ccsid: 5035, label: "5035 (EBCDIC 日本語・混在)", writable: true },
  { ccsid: 939, label: "939 (EBCDIC 日本語・英小文字)", writable: true },
  { ccsid: 930, label: "930 (EBCDIC 日本語・カタカナ)", writable: true },
  { ccsid: 1252, label: "1252 (Windows-1252)", writable: true },
  { ccsid: 943, label: "943 (Shift_JIS)", writable: false }
];

/** 表示用の名前。候補に無い CCSID はそのまま番号を返す */
export function ccsidLabel(ccsid: number): string {
  return TEXT_CCSIDS.find((c) => c.ccsid === ccsid)?.label ?? `CCSID ${ccsid}`;
}
