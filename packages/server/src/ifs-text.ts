/**
 * IFS のテキストを「どの文字コードとして読むか」を決める決定表。
 *
 * 判断だけを純関数に閉じてある（I/O を持たない）ので、組み合わせを網羅してテストできる。
 * 順序は spec のとおり **①手動指定 → ②BOM → ③UTF-8 → ④タグ**。
 *
 * **①（中身の推定）をタグより先に置くのが肝**——我々や他ツールが書いたファイルは
 * タグが中身を説明していない（UTF-8 の内容に CCSID 850 のタグが付く。research F4）。
 * タグを先に信じると、自分で書いたファイルを自分で化けさせる。
 */
import {
  canDecodeCcsid,
  canEncodeCcsid,
  decodeCcsidText,
  encodeCcsidText,
  type LineEnding
} from "@as400web/core";

/** 何を根拠にその文字コードを選んだか */
export type DetectedBy = "content" | "tag" | "manual";

export interface DecodedIfsText {
  content: string;
  /** 採用した文字コード */
  ccsid: number;
  detectedBy: DetectedBy;
  /** 元のファイルの行末（保存時にこれで戻す） */
  newline: LineEnding;
  /** BOM が付いていた（保存時に付け直す） */
  bom: boolean;
}

/**
 * 復号できなかった理由。
 *
 * - `unsupported`: 自動判定で読めなかった。**エラーではない**（読み取り自体は成功している）ので、
 *   呼び出し側は 200 ＋ `UNSUPPORTED_ENCODING` に倒して手動選択かダウンロードへ誘導する
 * - `manual-unsupported` / `manual-failed`: 利用者が選んだ文字コードの問題なので 4xx で返す
 */
export type DecodeFailure = "unsupported" | "manual-unsupported" | "manual-failed";

export type DecodeResult =
  | { ok: true; value: DecodedIfsText }
  | { ok: false; failure: DecodeFailure };

/** UTF-8 の BOM */
const BOM_UTF8 = [0xef, 0xbb, 0xbf];
/** UTF-16 の BOM（BE / LE）と、それぞれに対応する CCSID */
const BOM_UTF16 = [
  { bytes: [0xfe, 0xff], ccsid: 1200 },
  { bytes: [0xff, 0xfe], ccsid: 1202 }
];

/**
 * タグとして意味のない値。
 * - `0`: 未タグ（サーバー既定に任せた）
 * - `65535`: バイナリ（変換しない）。**タグでバイナリを判別できるわけではない**——
 *   65535 を指定して作ったファイルにもサーバー既定の 850 が付く（research F6）
 */
function usableTag(tag: number | undefined): tag is number {
  return tag !== undefined && tag !== 0 && tag !== 65535 && canDecodeCcsid(tag);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/** BOM から文字コードが分かるなら、その CCSID */
function ccsidFromBom(bytes: Uint8Array): number | undefined {
  if (startsWith(bytes, BOM_UTF8)) return 1208;
  return BOM_UTF16.find((b) => startsWith(bytes, b.bytes))?.ccsid;
}

function decoded(
  ccsid: number,
  bytes: Uint8Array,
  detectedBy: DetectedBy,
  bom: boolean
): DecodedIfsText {
  const { text, newline } = decodeCcsidText(ccsid, bytes);
  return { content: text, ccsid, detectedBy, newline, bom };
}

/**
 * 決定表を通してテキストを復号する。
 *
 * @param bytes 読み取ったバイト列（無変換）
 * @param tagCcsid ファイルの CCSID タグ（OA2）。取れなければ undefined
 * @param manualCcsid 利用者が選んだ文字コード
 */
export function decodeIfsText(
  bytes: Uint8Array,
  tagCcsid: number | undefined,
  manualCcsid?: number
): DecodeResult {
  const bom = ccsidFromBom(bytes) !== undefined;

  // ① 手動指定は何より優先する（自動判定が外れたときの逃げ道なので、推定で上書きしない）
  if (manualCcsid !== undefined) {
    if (!canDecodeCcsid(manualCcsid)) return { ok: false, failure: "manual-unsupported" };
    try {
      return { ok: true, value: decoded(manualCcsid, bytes, "manual", bom) };
    } catch {
      return { ok: false, failure: "manual-failed" };
    }
  }

  // ② BOM があればそれが最も確かな手掛かり
  const byBom = ccsidFromBom(bytes);
  if (byBom !== undefined) {
    try {
      return { ok: true, value: decoded(byBom, bytes, "content", true) };
    } catch {
      // BOM だけ付いた壊れたファイル。次の手段に落とす
    }
  }

  // ③ UTF-8 として成立するならそれを採る（fatal なので EBCDIC は誤爆しない。research F5）
  try {
    return { ok: true, value: decoded(1208, bytes, "content", false) };
  } catch {
    // UTF-8 ではなかった
  }

  // ④ タグに従う
  if (usableTag(tagCcsid)) {
    try {
      return { ok: true, value: decoded(tagCcsid, bytes, "tag", false) };
    } catch {
      // タグが中身と食い違っていた
    }
  }

  return { ok: false, failure: "unsupported" };
}

export interface EncodeOptions {
  newline?: LineEnding;
  bom?: boolean;
}

export type EncodeResult =
  | { ok: true; bytes: Uint8Array; substituted: number }
  | { ok: false; failure: "unsupported" };

/**
 * 保存するテキストを符号化する。読んだときの `ccsid` / `newline` / `bom` を渡すと元の流儀に戻る。
 *
 * 復号できても符号化できない文字コードがある（Shift_JIS 系。core の decisions D2）ので、
 * 書けない場合は**書き込む前に断る**。
 */
export function encodeIfsText(
  ccsid: number,
  text: string,
  opts: EncodeOptions = {}
): EncodeResult {
  if (!canEncodeCcsid(ccsid)) return { ok: false, failure: "unsupported" };
  const { bytes, substituted } = encodeCcsidText(ccsid, text, {
    ...(opts.newline !== undefined ? { newline: opts.newline } : {})
  });
  if (!opts.bom) return { ok: true, bytes, substituted };
  const prefix = bomBytesFor(ccsid);
  if (prefix === undefined) return { ok: true, bytes, substituted };
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return { ok: true, bytes: out, substituted };
}

/** その文字コードで BOM を付け直すならこのバイト列（BOM を持たない文字コードは undefined） */
function bomBytesFor(ccsid: number): readonly number[] | undefined {
  if (ccsid === 1208) return BOM_UTF8;
  return BOM_UTF16.find((b) => b.ccsid === ccsid)?.bytes;
}
