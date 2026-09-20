import { ByteWriter } from "./bytes.js";
import { buildRecord, CLIENT_FLAG2 } from "./gds.js";
import { COMMAND, ESC, ORDER } from "./constants.js";
import { SO, SI, type Codec } from "@ts5250/ebcdic";
import type { DbcsFieldType } from "../screen/types.js";
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
 *
 * **DBCS の再現は不完全**（lead/tail に元のバイト対を保持していないため、
 * エンコードし直せない文字は空白になる）。表示上の実害は無い——こちらの
 * RESTORE SCREEN は**積荷を画面へ適用せず**、ローカルの退避スタックから復元するため。
 * ここで送るバイト列はホストにとって不透明な保管物にすぎない。
 *
 * （積荷そのものは**照合のために読む**——返ってきたバイト列がここで送ったものと一致することを
 * 確かめてから、その長さぶんを読み飛ばす。`wtd-applier.ts` の `restoreAndSkipPayload`）
 *
 * **opcode は受信したレコードの写し**（`replyOpcode`）。ACS も
 * `DS5250.processSaveScreen` が `WorkHeader.Opcode` をそのまま書いており、実機のワイヤでも
 * SAVE SCREEN 要求（opcode 0x04）に対して **0x04** を返していた
 * （`20260920-restore-screen-parity` research F14）。以前は `OPCODE.RESTORE_SCREEN`(0x05) 固定で、
 * ホストは受理していたが**ACS と同じではなかった**（decisions D8 で過去の決定を破棄）。
 *
 * `payload` を一緒に返すのは、**ホストが RESTORE でこれをそのまま返してくる**ため
 * ——`ScreenBuffer.attachSaveContext()` に預け、復元時に読み飛ばす長さとして使う（decisions D2）。
 */
export function buildSaveScreenResponse(
  buf: ScreenBuffer,
  codec: Codec,
  replyOpcode: number
): SaveScreenResponse {
  const p = new ByteWriter();
  writeScreenAsWtd(p, buf, codec);
  const payload = p.toUint8Array();
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.RESTORE_SCREEN).bytes(payload);
  return { record: buildRecord(replyOpcode, w.toUint8Array(), {}, CLIENT_FLAG2), payload };
}

/** SAVE SCREEN / SAVE PARTIAL の応答（ホストへ送るレコードと、返ってくる積荷）。 */
export interface SaveScreenResponse {
  /** ホストへ送るレコード */
  record: Uint8Array;
  /** `ESC 0x12` の**後ろ**＝ホストが RESTORE でそのまま返してくる積荷 */
  payload: Uint8Array;
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
 * **これはホストが待っている返信である。**
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
 *
 * **パラメータ 5 バイトは受け取らない。** ホストは使っておらず（`20260730-tn5250-cross-check`
 * research F2）、写して返すと「自分が付けたものをホストの指定と誤解する」自作自演に戻る。
 * ~~受け取るが送り返さない~~ という形は「写さない」を注記でしか担保していなかったので、
 * **引数ごと落として構造で真にした**（`20260920-restore-screen-parity` review ラウンド 2）。
 * 記録は `ApplyResult.saveRequests[].params` に残る。
 *
 * ⚠ **いまは `buildSaveScreenResponse` の完全な別名**（引数も本体も同じ）。残してあるのは
 * 呼び出し側で「どちらのコマンドに答えているか」が読めるようにするため。
 */
export function buildSavePartialScreenResponse(
  buf: ScreenBuffer,
  codec: Codec,
  replyOpcode: number
): SaveScreenResponse {
  return buildSaveScreenResponse(buf, codec, replyOpcode);
}

/**
 * READ SCREEN（opcode 0x08 / ESC 0x62）への応答レコードを組み立てる。
 *
 * **これはホストが待っている返信である。** READ SCREEN は「今表示している画面の内容を
 * 送り返せ」という要求で、ASSUME 付き WINDOW（別の表示ファイルが描いた全画面の上に
 * ウィンドウを重ねる）で、ホストが「既にあると仮定している画面」を取得するために送ってくる。
 * 返信しないとホストは先へ進まず、後続のウィンドウ描画を送ってこない。
 *
 * 形式は**画面全域を先頭位置から末尾位置まで 1 桁 1 バイトで並べたイメージだけ**
 * （属性桁は属性バイト、文字桁は EBCDIC）。SBA 等のオーダーは付けない（フラットなスキャン）。
 *
 * **ACS の実測に合わせてある**（`20260920-restore-screen-parity` の実機計測。DSM の
 * `QsnPutInpCmd(0x66)` でホストに出させ、`scripts/tap-proxy.mjs` で ACS の応答を採った）:
 *
 * - **カーソル位置を前置しない**（~~「カーソル行(1) 桁(1)」に続けて~~）。ACS は 1,920 バイト
 *   ちょうど（24×80）を返す。
 * - **opcode は受信したレコードの写し**（~~PUT_GET(0x03) 固定~~）。実機は 0x66 を opcode 0x08 で
 *   送ってきて、ACS は 0x08 で返していた。
 * - **未書き込み桁は `0x00`**（~~空白 0x40~~）。ACS は `HostPlane` をそのまま返すので、
 *   何も書かれていない桁は 0x00 のまま（実測では 1,920 バイト中 1,388 が 0x00 だった）。
 *
 * ACS 側の実装は `DS5250.processReadScreen()`——`ps.getBuffer()`（＝`HostPlane` の写し）を
 * 画面サイズぶん 1 バイトずつ書き、ヘッダの opcode に `WorkHeader.Opcode` を置く。
 *
 * **実測は 0x66 で採ったが、0x62 にも同じ形が当たる**——ACS のコマンド振り分けは
 * `case 98:`（0x62）と `case 102:`（0x66）を**同じ `processReadScreen(bl)` へ落とす**
 * （`bl = (受信コマンド != 98)`）。前置の有無・opcode・未書き込み桁の扱いは `bl` に依らない。
 * `bl` が分けているのは**上位バイトの立った桁の加工だけ**で、0x62 のときに 8 ビット右へ送り
 * `0x11→0x13` / `0x10→0x12` / `0x07→0x08` に写す——これは ACS の `HostPlane` に拡張属性を
 * 畳み込む内部表現の話で、**当 PJ にはその表現が無いので対応物も無い**（未確認ではなく該当なし）。
 */
export function buildReadScreenResponse(
  buf: ScreenBuffer,
  codec: Codec,
  replyOpcode: number
): Uint8Array {
  const w = new ByteWriter();
  const ends = fieldEndAttrAddrs(buf);
  // 画面全域をスキャン。DBCS の lead は 2 バイト書き tail は 0 バイト（桁数は保たれる）。
  for (let addr = 0; addr < buf.size; addr++) writeCell(w, buf, addr, codec, 0x00, ends);
  return buildRecord(replyOpcode, w.toUint8Array(), {}, CLIENT_FLAG2);
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
  // 候補は「今生きているフィールドの終端」＋「SOH 等で消える前から引き継いだ終端」
  // （`retainedFieldEnds` 参照）。後者を含めないと、窓を重ねる過程で SOH がフィールドテーブルを
  // 消した直後にこの応答を組むとき、消えたフィールドの終端へ閉じ属性を送れない。
  const candidates = new Set<number>(buf.retainedFieldEnds());
  for (const f of fields) candidates.add(f.startAddr + f.length);
  const ends = new Set<number>();
  for (const addr of candidates) {
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
 * - レコードヘッダは**受信したレコードの opcode の写し**・フラグ 2 バイト目 0x80。
 *   実測した ACS の応答は 0x08 で、実機が送ってくる 0x64 のレコードも opcode 0x08 だった
 *   ——**0x62 / 0x66 と同じ規則**（`20260920-restore-screen-parity` research F14・実機計測）。
 *   ⚠ **当 PJ で写しに変えたのは SAVE / READ SCREEN / READ SCREEN EXTENDED の 3 経路だけ**。
 *   `buildReadImmediateResponse`(0x72) と `buildReadMdtImmediateAltResponse`(0x83) は
 *   `PUT_GET` 固定のまま——**実機で測っていないので変えていない**（同 review ラウンド 5）
 *
 * 形式が違うと、ホストは応答の中身を見ずに「適用業務ヘルプ中に機能チェックが起こった」を
 * 返してヘルプを送ってこない（日本語実機で 9 通りの誤った形式を試して確認）。
 */
export function buildReadScreenExtendedResponse(
  buf: ScreenBuffer,
  codec: Codec,
  replyOpcode: number
): Uint8Array {
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
  return buildRecord(replyOpcode, w.toUint8Array(), {}, CLIENT_FLAG2);
}

/** DBCS 種別 → FCW（ACS `Field5250` の定数と同じ対応。`applySf` の振り分けの逆） */
function fcwFor(kind: DbcsFieldType): number {
  if (kind === "only") return 0x8200;
  if (kind === "pure") return 0x8220;
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
    // **ホストが書いた桁は受信した生バイトをそのまま返す**（SBCS 側と同じ規則）。
    // `setDbcs()` は lead/tail に元のバイト対を保持しているので、符号化し直さずに戻せる
    // ——ACS も `HostPlane` をそのまま返す（`20260920-restore-screen-parity` research F3・F4）。
    // 符号化し直すと、戻せない字が空白 2 桁に化ける（同 work の review ラウンド 1）
    // `setDbcs()` が `checkAddr(addr + 1)` で守るので lead が最終桁に来ることは無いが、
    // **ここで例外を投げると応答そのものが組めなくなる**ので境界を確かめてから読む
    const tail = addr + 1 < buf.size ? buf.cellAt(addr + 1) : null;
    // **`charKind` まで確かめる**——lead の対が SBCS で上書きされた欄では、その SBCS バイトを
    // DBCS の trail として送ることになる（`20260920-restore-screen-parity` review ラウンド 2）
    if (
      cell.rawByte !== undefined &&
      tail?.type === "char" &&
      tail.charKind === "dbcs-tail" &&
      tail.rawByte !== undefined
    ) {
      w.u8(cell.rawByte).u8(tail.rawByte);
      return;
    }
    const pair = codec.encodeDbcsChar?.(cell.char.codePointAt(0) ?? 0x20);
    if (pair === undefined) {
      w.u8(0x40).u8(0x40); // 戻せない文字は空白 2 桁（桁位置は保つ）
      return;
    }
    w.u8((pair >> 8) & 0xff).u8(pair & 0xff);
    return;
  }
  // **ホストが書いた桁は受信した生バイトを、それ以外は文字を符号化して返す。**
  //
  // ACS は表示バッファ（`PS5250` の `HostPlane`）に**打鍵した文字も**入れ（`putSBChar`）、
  // 画面イメージ応答はその `HostPlane` をそのまま返す（`DS5250.processReadScreen` →
  // `getBuffer()`。`20260920-restore-screen-parity` research F3・F4）。
  // 当 PJ は以前 `rawByte ?? 0x40` としていたので、**`setFieldValue` で入れた文字
  // （＝利用者が打った文字）が空白に化けていた**（同 research F10）。
  //
  // `hostByte` は表示に使えない元バイト（オーダー 0x1C / 0x1E）。`buffer.ts` の注記を参照。
  w.u8(cell.rawByte ?? cell.hostByte ?? encodeSbcs(cell.char, codec));
}

/**
 * SBCS 1 文字を EBCDIC の 1 バイトへ。表せない文字は空白（桁位置は保つ）。
 *
 * **全角は届かない**——`setFieldValue` は DBCS 欄の全角 1 文字を 1 セルに置くので、
 * ここへ来ると `bytes.length !== 1` で 0x40 に倒れ、桁もずれる。従来の `rawByte ?? 0x40` と
 * 同じ結果なので退行ではないが、**DBCS 欄に打鍵した全角は画面イメージ応答に載らない**
 * （`20260920-restore-screen-parity` review ラウンド 1。未確認のまま残す）。
 */
function encodeSbcs(char: string, codec: Codec): number {
  const { bytes, substituted } = codec.encode(char);
  // **1 バイトに収まらないものは載せない**——SO/SI が付く・DBCS になるなどで桁がずれる。
  // 置換が起きたもの（`substituted > 0`）も、別の文字を送ることになるので空白にする
  if (bytes.length !== 1 || substituted > 0) return 0x40;
  const b = bytes[0] ?? 0x40;
  // **オーダー帯（< 0x20）と属性帯（0x20–0x3F）は空白に倒す。**
  //
  // `validateFieldContent` は制御文字を弾かない（シフト無しの欄は `substituted` しか見ない）ので、
  // WS/MCP/マクロ経由で C0 制御を書けてしまう。それがそのまま載ると、`writeScreenAsWtd` の
  // 積荷では**別のオーダー列**に、画面イメージ応答では**属性バイト**（`isAttribute` は 0x20–0x3F）に
  // 化ける——後者はオーダーより静かに壊れる。
  //
  // **実測**（CCSID 37 / 273 / 930 / 939 / 1399。`codecForCcsid` が受ける 10 個のうち 5 つ。
  // `20260920-restore-screen-parity` review ラウンド 3・4・5）:
  // C0 制御（U+0000–U+001F）は 5 つとも属性帯へ 11 件落ちる（U+000A→0x25・U+001A→0x3F ほか）。
  // **表示文字——U+0020 以上から DEL（U+007F）と C1（U+0080–U+009F）を除いた範囲——が
  // 0x40 未満へ落ちるものは 1 件も無い**ので、この条件で失う文字は無い。
  return b < 0x40 ? 0x40 : b;
}
