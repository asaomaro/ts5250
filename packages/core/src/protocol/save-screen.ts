import { ByteWriter } from "./bytes.js";
import { buildRecord } from "./gds.js";
import { COMMAND, ESC, OPCODE, ORDER } from "./constants.js";
import { SO, SI, type Codec } from "@as400web/ebcdic";
import type { ScreenBuffer } from "../screen/buffer.js";

/**
 * SAVE SCREEN（opcode 0x04 / ESC 0x02）への応答レコードを組み立てる。
 *
 * **これはホストが待っている返信である。** SAVE SCREEN は「画面を退避しろ」という
 * 一方向の指示ではなく、**端末に画面の内容を送り返させる要求**で、ホストは受け取った
 * バイト列を保管し、あとで RESTORE SCREEN としてそのまま返してくる。
 * 返信しないとホストは先へ進まない——SEU の F1 でヘルプが 30 秒返らなかったのがこれ。
 *
 * 返すのは `ESC RESTORE_SCREEN` に続けて、現在の画面を再現する WTD ストリーム。
 * opcode は RESTORE_SCREEN（0x05）。
 *
 * **DBCS の再現は不完全**（lead/tail に元のバイト対を保持していないため、
 * エンコードし直せない文字は空白になる）。表示上の実害は無い——こちらの
 * RESTORE SCREEN はホストの積荷を読まず、ローカルの退避スタックから復元するため。
 * ここで送るバイト列はホストにとって不透明な保管物にすぎない。
 */
export function buildSaveScreenResponse(buf: ScreenBuffer, codec: Codec): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.RESTORE_SCREEN);
  writeScreenAsWtd(w, buf, codec);
  return buildRecord(OPCODE.RESTORE_SCREEN, w.toUint8Array());
}

/** 現在の画面を再現する WTD ストリームを書き出す（SAVE SCREEN / SAVE PARTIAL SCREEN 共通） */
function writeScreenAsWtd(w: ByteWriter, buf: ScreenBuffer, codec: Codec): void {
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x00); // CC1/CC2 とも副作用なし

  const fieldStarts = new Map<number, ReturnType<ScreenBuffer["orderedFields"]>[number]>();
  for (const f of buf.orderedFields()) fieldStarts.set(f.startAddr, f);

  let addr = 0;
  let pending = true; // 直後に SBA が必要か（先頭と飛び越しの後）
  while (addr < buf.size) {
    const field = fieldStarts.get(addr + 1);
    if (field !== undefined) {
      // フィールド定義は属性桁（startAddr - 1）から。applySf と同じ並び:
      // SF, FFW(2), FCW(2 任意), 属性(1), 長さ(2)
      writeSba(w, buf, addr);
      w.u8(ORDER.SF).u16(field.ffw);
      if (field.dbcsType !== undefined) w.u16(fcwFor(field.dbcsType));
      w.u8(field.attrByte).u16(field.length);
      for (let i = 0; i < field.length; i++) writeCell(w, buf, field.startAddr + i, codec);
      addr = field.startAddr + field.length;
      pending = true;
      continue;
    }
    const cell = buf.cellAt(addr);
    if (cell === null) {
      addr++;
      pending = true; // 既定の空白は書かずに飛ばす（RA を使わずとも復元後は空白）
      continue;
    }
    if (pending) {
      writeSba(w, buf, addr);
      pending = false;
    }
    writeCell(w, buf, addr, codec);
    addr += cell.type === "char" && cell.charKind === "dbcs-lead" ? 2 : 1;
  }
}

/**
 * SAVE PARTIAL SCREEN（ESC 0x03）への応答レコードを組み立てる。
 *
 * **これはホストが待っている返信である**（opcode は PUT/GET＝「送ったから返せ」）。
 * 返さないとホストは次を送ってこず、**QSH が「待機中・ホストから応答がない」で固まる**。
 *
 * ## 中身は SAVE SCREEN（0x02）の応答と**同じ**にする
 *
 * ホストにとってこの中身は**不透明な保管物**で、復元時に**そのまま返ってくる**
 * （実機で実験して確かめた——応答から先頭の 7 バイトを外すと、
 * 返ってくるレコードもちょうど 7 バイト短くなり、`ESC 13` が消えた。
 * `20260730-tn5250-cross-check` research F4）。
 *
 * 以前は先頭に `ESC RESTORE_PARTIAL_SCREEN` ＋受け取った 5 バイトの写しを付けていたが、
 * **それが返ってきたものを「ホストが送ってきた 0x13」と誤解して 5 バイト読み飛ばす**
 * という自作自演になっていた。原典（tn5250）は `0x13` を**パラメータ無し**として扱う。
 *
 * 先頭の `ESC RESTORE_SCREEN` は**局所の退避を戻す目印**として残す
 * ——長く実機で動いている形で、`0x02` と同じ役割を果たす。
 * `params` は受け取るが**送り返さない**（ホストは使っていない。research F2）。
 */
export function buildSavePartialScreenResponse(
  buf: ScreenBuffer,
  codec: Codec,
  params: Uint8Array
): Uint8Array {
  void params; // 記録として受け取るだけ（原典も値を使っていない）
  return buildSaveScreenResponse(buf, codec);
}

/**
 * READ SCREEN（opcode 0x08 / ESC 0x62）への応答レコードを組み立てる。
 *
 * **これはホストが待っている返信である。** READ SCREEN は「今表示している画面の内容を
 * 送り返せ」という要求で、ASSUME 付き WINDOW（別の表示ファイルが描いた全画面の上に
 * ウィンドウを重ねる）で、ホストが「既にあると仮定している画面」を取得するために送ってくる。
 * 返信しないとホストは先へ進まず、後続のウィンドウ描画を送ってこない。
 *
 * 形式は他の Read 応答と同じ「カーソル行(1) 桁(1)」に続けて、画面全域を先頭位置から
 * 末尾位置まで 1 桁 1 バイトで並べたイメージ（属性桁は属性バイト、文字桁は EBCDIC）。
 * SBA 等のオーダーは付けない（フラットなスキャン）。opcode は PUT_GET（0x03）。
 */
export function buildReadScreenResponse(buf: ScreenBuffer, codec: Codec): Uint8Array {
  const w = new ByteWriter();
  const cur = buf.rowColOf(buf.cursorAddr);
  w.u8(cur.row).u8(cur.col);
  const ends = fieldEndAttrAddrs(buf);
  // 画面全域をスキャン。DBCS の lead は 2 バイト書き tail は 0 バイト（桁数は保たれる）。
  for (let addr = 0; addr < buf.size; addr++) writeCell(w, buf, addr, codec, 0x40, ends);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/** READ SCREEN EXTENDED の行区切り（ACS 実機の応答を実測して判明） */
const ROW_DELIMITER = 0xff;

/** 通常属性（緑・下線等なし）。フィールド終端の閉じ属性に使う */
const NORMAL_ATTR = 0x20;

/**
 * **フィールド終端に置く閉じ属性の位置**（READ SCREEN 系の応答用）。
 *
 * 5250 のフィールドは開始属性しか持たず、終端は**フォーマットテーブルの長さ**で決まる。
 * 画面イメージ（READ SCREEN）にはフォーマットテーブルが乗らないので、そのまま送ると
 * 「下線がどこで終わるか」がホストに伝わらない。ホストはヘルプウィンドウを出すとき、
 * この応答をそのまま描き直して背面を再現するため（CLEAR UNIT ＋全画面 WTD）、閉じ属性が
 * 無いと **背面の下線が入力範囲を越えて伸びる**——ACS は背面がヘルプ前とまったく変わらない
 * のに対し、こちらだけ罫線が行末まで伸び次行へ回り込んでいた（実機の PDM F1）。
 *
 * そこで**空いている終端桁にだけ**通常属性を置いて送る。ホストの描き直しがそれを含むので
 * 背面が元どおりに再現される。潰すと情報が壊れる桁（ホストが何か書いた桁・別の欄のデータ桁）は
 * 対象外。画面バッファ自体は変更しない（送るイメージの中だけの補完）。
 */
function fieldEndAttrAddrs(buf: ScreenBuffer): ReadonlySet<number> {
  const fields = buf.orderedFields();
  const fieldData = new Set<number>();
  for (const f of fields) {
    for (let i = 0; i < f.length; i++) fieldData.add(f.startAddr + i);
  }
  const ends = new Set<number>();
  for (const f of fields) {
    const addr = f.startAddr + f.length;
    if (addr >= buf.size || fieldData.has(addr)) continue;
    if (buf.cellAt(addr) !== null) continue; // ホストが書いた桁は上書きしない
    ends.add(addr);
  }
  return ends;
}

/**
 * READ SCREEN EXTENDED（opcode 0x08 / ESC 0x64）への応答レコードを組み立てる。
 *
 * 拡張 5250 を申告した端末には、ホストは READ SCREEN（0x62）ではなくこちらを送ってくる。
 * **形式は 0x62 とはまったく別物**で、ACS 実機（IBM i 日本語機）の応答を実測して次と判明した:
 *
 * - カーソル位置の前置は **無い**（いきなり画面 1 行目 1 桁目から始まる）
 * - 1 行ぶんのバイト列を並べ、行末に区切りバイト `0xFF` を置く。これを行数ぶん繰り返す
 * - 行末の **NUL（未書き込み桁）は切り詰める**。行全体が NUL なら長さ 0（区切りだけ）。
 *   ブランク（0x40）は切り詰めない——実測で末尾 0x40 のまま 80 バイト送っている行がある
 * - レコードヘッダは opcode READ_SCREEN(0x08)・フラグ 2 バイト目 0x80
 *
 * 形式が違うと、ホストは応答の中身を見ずに「適用業務ヘルプ中に機能チェックが起こった」を
 * 返してヘルプを送ってこない（日本語実機で 9 通りの誤った形式を試して確認）。
 */
export function buildReadScreenExtendedResponse(buf: ScreenBuffer, codec: Codec): Uint8Array {
  const w = new ByteWriter();
  const ends = fieldEndAttrAddrs(buf);
  for (let row = 0; row < buf.rows; row++) {
    const line = new ByteWriter();
    for (let col = 0; col < buf.cols; col++) writeCell(line, buf, row * buf.cols + col, codec, 0x00, ends);
    const bytes = line.toUint8Array();
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0x00) end--; // 行末の未書き込み桁は送らない
    w.bytes(bytes.subarray(0, end)).u8(ROW_DELIMITER);
  }
  return buildRecord(OPCODE.READ_SCREEN, w.toUint8Array(), {}, 0x80);
}

function fcwFor(kind: "pure" | "open" | "either"): number {
  if (kind === "pure") return 0x8200;
  if (kind === "either") return 0x8240;
  return 0x8280;
}

/** SBA（1 始まりの行・桁を 1 バイトずつ） */
function writeSba(w: ByteWriter, buf: ScreenBuffer, addr: number): void {
  const { row, col } = buf.rowColOf(addr);
  w.u8(ORDER.SBA).u8(row).u8(col);
}

/**
 * 1 桁ぶんを書く。empty は未書き込み桁に出すバイト（既定は空白 0x40）。
 * fieldEnds に載る空き桁にはフィールドの閉じ属性を出す（`fieldEndAttrAddrs` 参照）。
 */
function writeCell(
  w: ByteWriter,
  buf: ScreenBuffer,
  addr: number,
  codec: Codec,
  empty = 0x40,
  fieldEnds?: ReadonlySet<number>
): void {
  const cell = buf.cellAt(addr);
  if (cell === null) {
    w.u8(fieldEnds?.has(addr) === true ? NORMAL_ATTR : empty);
    return;
  }
  if (cell.type === "attr") {
    w.u8(cell.byte);
    return;
  }
  if (cell.charKind === "so") {
    w.u8(SO);
    return;
  }
  if (cell.charKind === "si") {
    w.u8(SI);
    return;
  }
  if (cell.charKind === "dbcs-tail") return; // lead 側で 2 バイト書いている
  if (cell.charKind === "dbcs-lead") {
    const pair = codec.encodeDbcsChar?.(cell.char.codePointAt(0) ?? 0x20);
    if (pair === undefined) {
      w.u8(0x40).u8(0x40); // 戻せない文字は空白 2 桁（桁位置は保つ）
      return;
    }
    w.u8((pair >> 8) & 0xff).u8(pair & 0xff);
    return;
  }
  w.u8(cell.rawByte ?? 0x40);
}
