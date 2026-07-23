/**
 * CCSID を指定してテキストを復号・符号化する単一の入口。
 *
 * EBCDIC 系は既存の `codecForCcsid`（表を同梱している）、
 * それ以外（UTF-8 / ISO-8859-1 / UTF-16 / Windows-1252 / Shift_JIS）は Web 標準の
 * `TextDecoder` に橋渡しする。**表を増やさずに済む範囲は増やさない**——
 * CCSID 850 / 437 は Node の `TextDecoder` に無いが、実機で 850 タグが付くのは
 * 「中身は UTF-8 / ASCII なのにサーバー既定のタグが付いた」ケースで、
 * 復号の決定表ではタグより先に中身の推定が当たる（research F4）。
 * 本当に CP850 の内容が現れたら `tools/gen-tables` で表を起こすこと。
 *
 * ピュアロジック層なので `node:*` は使わない（`TextDecoder` / `TextEncoder` は Web 標準）。
 */
import { codecForCcsid } from "./codec.js";
import type { LineEnding } from "./ccsid-catalog.js";

export { TEXT_CCSIDS, ccsidLabel } from "./ccsid-catalog.js";
export type { LineEnding } from "./ccsid-catalog.js";

/** 復号結果。`newline` は元のファイルで優勢だった行末 */
export interface CcsidText {
  text: string;
  newline: LineEnding;
}

/** NEL（次の行）。EBCDIC 0x15 の Unicode 対応先 */
const NEL = "\u0085";

/**
 * `TextDecoder` に任せる CCSID → ラベル。
 *
 * - 1200 / 13488 は UTF-16BE（IFS のファイル名 CCSID と同じ）
 * - 932 / 943 のラベル `shift_jis` は WHATWG では **Windows-31J**。
 *   IBM 943 と完全に同じ表ではない（外字・NEC/IBM 選定文字の扱いが違う）ので、
 *   ずれが問題になるなら表を起こすこと
 */
const DECODER_LABELS: ReadonlyMap<number, string> = new Map([
  [1208, "utf-8"],
  [819, "iso-8859-1"],
  [1252, "windows-1252"],
  [5348, "windows-1252"],
  [1200, "utf-16be"],
  [13488, "utf-16be"],
  [17584, "utf-16be"],
  [1202, "utf-16le"],
  [13490, "utf-16le"],
  [932, "shift_jis"],
  [943, "shift_jis"]
]);

/**
 * 符号化まで出来る非 EBCDIC の CCSID。
 *
 * `TextEncoder` は **UTF-8 しか吐けない**ので、それ以外は自前で戻す:
 * - UTF-16BE は素直に 2 バイトずつ
 * - 単バイト系（819 / 1252）は「全 256 バイトを復号して逆引き表を作る」ことで表を持たずに戻せる
 * - Shift_JIS 系（932 / 943）は多バイトのため同じ手が使えない。**読み取り専用**とする
 *   （保存しようとしたら呼び出し側が断る。`canEncodeCcsid`）
 */
const SINGLE_BYTE_LABELS = new Set(["iso-8859-1", "windows-1252"]);

/** 単バイト系の逆引き表（Unicode → バイト）。初回だけ作って使い回す */
const reverseTables = new Map<string, Map<number, number>>();

function reverseTableFor(label: string): Map<number, number> {
  const cached = reverseTables.get(label);
  if (cached) return cached;
  const decoder = new TextDecoder(label);
  const table = new Map<number, number>();
  const one = new Uint8Array(1);
  for (let b = 0; b < 256; b++) {
    one[0] = b;
    const ch = decoder.decode(one);
    const cp = ch.codePointAt(0);
    // 逆引きは**最初に現れたバイトを採る**（Windows-1252 の未定義位置が U+FFFD に潰れるため）
    if (cp !== undefined && cp !== 0xfffd && !table.has(cp)) table.set(cp, b);
  }
  reverseTables.set(label, table);
  return table;
}

/** EBCDIC 系（同梱の表で読める）か */
export function isEbcdicCcsid(ccsid: number): boolean {
  try {
    codecForCcsid(ccsid);
    return true;
  } catch {
    return false;
  }
}

/** この CCSID で復号できるか */
export function canDecodeCcsid(ccsid: number): boolean {
  return DECODER_LABELS.has(ccsid) || isEbcdicCcsid(ccsid);
}

/**
 * この CCSID で**符号化**できるか（保存に使えるか）。
 * 復号できても符号化できない CCSID がある（Shift_JIS 系）。
 */
export function canEncodeCcsid(ccsid: number): boolean {
  if (isEbcdicCcsid(ccsid)) return true;
  const label = DECODER_LABELS.get(ccsid);
  if (label === undefined) return false;
  return label.startsWith("utf-") || SINGLE_BYTE_LABELS.has(label);
}

/**
 * バイト列を CCSID で復号する。
 *
 * **未対応の CCSID と、その文字コードとして成立しないバイト列は例外**（`RangeError` / `TypeError`）。
 * 黙って U+FFFD を並べると、それを編集して書き戻したときに元ファイルが壊れる。
 *
 * ただし EBCDIC は 1 バイトずつ必ず何かに対応するため「読めない」を検出できない
 * （選択が違えば化けた文字列がそのまま返る）。だから採用した CCSID を UI に見せて、
 * 利用者が選び直せるようにしている。
 */
export function decodeCcsidText(ccsid: number, bytes: Uint8Array): CcsidText {
  const label = DECODER_LABELS.get(ccsid);
  if (label !== undefined) {
    const text = new TextDecoder(label, { fatal: true }).decode(bytes);
    // NEL の正規化は EBCDIC 限定。UTF-8 の本文に現れた U+0085 を改行に変えない
    return { text, newline: "lf" };
  }
  const text = codecForCcsid(ccsid).decode(bytes);
  return normalizeNel(text);
}

/**
 * 文字列を CCSID で符号化する。`substituted` はマップ不能で SUB に落とした文字数。
 *
 * `newline: "nel"` なら `\n` を U+0085（EBCDIC 0x15）に戻してから符号化する
 * ——読んだファイルの行末の流儀を保つため。EBCDIC 以外では無視する。
 */
export function encodeCcsidText(
  ccsid: number,
  text: string,
  opts: { newline?: LineEnding } = {}
): { bytes: Uint8Array; substituted: number } {
  const label = DECODER_LABELS.get(ccsid);
  if (label === undefined) {
    const source = opts.newline === "nel" ? text.replaceAll("\n", NEL) : text;
    return codecForCcsid(ccsid).encode(source);
  }
  if (label === "utf-8") return { bytes: new TextEncoder().encode(text), substituted: 0 };
  if (label === "utf-16be" || label === "utf-16le") {
    const little = label === "utf-16le";
    const bytes = new Uint8Array(text.length * 2);
    const v = new DataView(bytes.buffer);
    for (let i = 0; i < text.length; i++) v.setUint16(i * 2, text.charCodeAt(i), little);
    return { bytes, substituted: 0 };
  }
  if (!SINGLE_BYTE_LABELS.has(label)) {
    throw new RangeError(`cannot encode to CCSID ${ccsid} (decode only)`);
  }
  const table = reverseTableFor(label);
  const bytes = new Uint8Array(text.length);
  let substituted = 0;
  for (let i = 0; i < text.length; i++) {
    const b = table.get(text.charCodeAt(i));
    if (b === undefined) {
      bytes[i] = 0x1a; // SUB（ASCII 系の置換文字）
      substituted++;
    } else {
      bytes[i] = b;
    }
  }
  return { bytes, substituted };
}

/**
 * EBCDIC の復号結果から行末を判定し、NEL を `\n` に正規化する。
 *
 * **復号後に数える**——SO/SI で囲まれた DBCS の 2 バイト目に 0x15 が現れうるため、
 * バイト列のまま数えると混在ファイルで誤判定する。
 * 両方あるファイルは多い方を採る（同数なら LF＝そのまま）。
 */
function normalizeNel(text: string): CcsidText {
  let nel = 0;
  let lf = 0;
  for (const ch of text) {
    if (ch === NEL) nel++;
    else if (ch === "\n") lf++;
  }
  if (nel === 0 || nel <= lf) return { text, newline: "lf" };
  return { text: text.replaceAll(NEL, "\n"), newline: "nel" };
}
