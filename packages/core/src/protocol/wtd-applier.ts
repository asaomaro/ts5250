import { As400Error } from "../errors.js";
import { type Codec, SO, SI } from "../codec/codec.js";
import type { ScreenBuffer } from "../screen/buffer.js";
import { ByteReader } from "./bytes.js";
import { ESC, COMMAND, ORDER, isAttribute } from "./constants.js";
import { parseWdsf } from "./wdsf-parser.js";

/** データストリーム適用の結果（キーボード状態の遷移は Session が判断する） */
export interface ApplyResult {
  lockKeyboard: boolean;
  unlockKeyboard: boolean;
  /** Read 系コマンドを受けた（＝ホストが入力を待っている） */
  readRequested: boolean;
  alarm: boolean;
  /** ホストが 5250 QUERY を送ってきた（Query Reply を返す必要がある） */
  queryRequested: boolean;
  /** ホストが SAVE SCREEN を送ってきた（画面を送り返す必要がある） */
  saveScreenRequested: boolean;
  /** ホストが READ SCREEN を送ってきた（現在の画面イメージを送り返す必要がある） */
  readScreenRequested: boolean;
  /** ホストが READ SCREEN EXTENDED を送ってきた（0x62 とは応答形式が異なる） */
  readScreenExtendedRequested: boolean;
  /** このレコード中で IC/MC によりカーソル位置が明示された */
  cursorSet: boolean;
}

/** CC2 ビット（SC30-3533。GNU tn5250 session.h と一致確認済み） */
const CC2_UNLOCK = 0x08;
const CC2_ALARM = 0x04;

export type WarnFn = (message: string) => void;

/**
 * 1 レコード分のデータストリーム（ESC+コマンド列）を ScreenBuffer に適用する。
 * 未知のコマンド/オーダーは警告してレコードの残りを打ち切る（レコード境界で再同期。spec「エラー処理」）。
 */
export function applyDataStream(
  data: Uint8Array,
  buf: ScreenBuffer,
  codec: Codec,
  warn: WarnFn = () => {}
): ApplyResult {
  const r = new ByteReader(data);
  const result: ApplyResult = {
    lockKeyboard: false,
    unlockKeyboard: false,
    readRequested: false,
    alarm: false,
    queryRequested: false,
    saveScreenRequested: false,
    readScreenRequested: false,
    readScreenExtendedRequested: false,
    cursorSet: false
  };

  while (r.remaining > 0) {
    const esc = r.u8();
    if (esc !== ESC) {
      warn(`expected ESC, got 0x${esc.toString(16)} — discarding rest of record`);
      break;
    }
    const cmd = r.u8();
    switch (cmd) {
      case COMMAND.CLEAR_UNIT:
        buf.clearUnit();
        break;
      case COMMAND.CLEAR_UNIT_ALTERNATE: {
        // Clear Unit Alternate は 1 バイトのパラメータ（アルタネート形式・通常 0x00）を伴う。
        // これを消費しないと後続コマンドの ESC 同期がずれ、画面本体を取りこぼす
        // （DBCS 端末 IBM-5555-C01 の SEU 等がこの命令を使う）。
        r.u8();
        // 27x132 へ切替えクリア。24x80 端末（alternate 未許可）では通常クリアにフォールバック
        if (!buf.clearUnitAlternate()) {
          warn("CLEAR UNIT ALTERNATE on 24x80 terminal — falling back to CLEAR UNIT");
          buf.clearUnit();
        }
        break;
      }
      case COMMAND.CLEAR_FORMAT_TABLE:
        buf.clearFormatTable();
        break;
      case COMMAND.SAVE_SCREEN:
        // SAVE SCREEN（ESC 0x02）: 現バッファを退避。後続の WTD がオーバーレイを描く。
        // **加えてホストへ画面を送り返す必要がある**（呼び出し側が応答レコードを送る）。
        // 返信しないとホストは待ち続ける——SEU の F1 でヘルプが返らなかった原因。
        buf.saveScreen();
        result.saveScreenRequested = true;
        break;
      case COMMAND.RESTORE_SCREEN:
        if (!buf.restoreScreen()) warn("RESTORE SCREEN with empty save stack");
        break;
      case COMMAND.WRITE_TO_DISPLAY:
        applyWtd(r, buf, codec, result, warn);
        break;
      case COMMAND.WRITE_ERROR_CODE:
        applyWriteErrorCode(r, buf, codec);
        break;
      case COMMAND.WRITE_STRUCTURED_FIELD:
        if (applyStructuredField(r, warn)) result.queryRequested = true;
        break;
      case COMMAND.READ_MDT_FIELDS:
      case COMMAND.READ_MDT_FIELDS_ALT:
      case COMMAND.READ_INPUT_FIELDS: {
        applyCc(r.u8(), buf, result);
        applyCc2(r.u8(), result);
        result.readRequested = true;
        result.unlockKeyboard = true; // Read はキーボードを解放して入力を待つ
        break;
      }
      case COMMAND.READ_SCREEN:
        // READ SCREEN（opcode 0x08 / ESC 0x62）: パラメータ無し。現在の画面イメージを
        // ホストへ送り返す要求。ASSUME 付き WINDOW（別表示ファイルの画面に重ねる）で、
        // ホストが「既にあると仮定した画面」を取得するために送ってくる。返信しないと
        // ホストは停止し、後続のウィンドウ描画を送ってこない（キーボードがロックのまま）。
        result.readScreenRequested = true;
        break;
      case COMMAND.READ_SCREEN_EXTENDED:
        // 拡張 5250 を申告した端末にはホストがこちらを送ってくる。応答形式は 0x62 と別
        // （buildReadScreenExtendedResponse 参照）。
        result.readScreenExtendedRequested = true;
        break;
      default:
        warn(`unknown command 0x${cmd.toString(16)} — discarding rest of record`);
        return result;
    }
  }
  return result;
}

/** CC1（上位 3 ビット）: ロックと MDT リセット/フィールド null 化（GNU tn5250 の解釈と一致） */
function applyCc(cc1: number, buf: ScreenBuffer, result: ApplyResult): void {
  const mode = cc1 & 0xe0;
  if (mode !== 0x00) result.lockKeyboard = true;
  switch (mode) {
    case 0x40:
      buf.resetMdtNonBypass();
      break;
    case 0x60:
      buf.resetMdt();
      break;
    case 0x80:
      buf.nullNonBypass(true);
      break;
    case 0xa0:
      buf.resetMdtNonBypass();
      buf.nullNonBypass(false);
      break;
    case 0xc0:
      buf.resetMdtNonBypass();
      buf.nullNonBypass(true);
      break;
    case 0xe0:
      buf.resetMdt();
      buf.nullNonBypass(false);
      break;
  }
}

function applyCc2(cc2: number, result: ApplyResult): void {
  if ((cc2 & CC2_UNLOCK) !== 0) result.unlockKeyboard = true;
  if ((cc2 & CC2_ALARM) !== 0) result.alarm = true;
}

function applyWtd(
  r: ByteReader,
  buf: ScreenBuffer,
  codec: Codec,
  result: ApplyResult,
  warn: WarnFn
): void {
  applyCc(r.u8(), buf, result);
  applyCc2(r.u8(), result);

  let addr = 0; // WTD 開始時のバッファアドレスは SBA で設定される（未設定時は先頭）
  let dbcsMode = false; // SO..SI 間は DBCS（2 バイト）モード

  while (r.remaining > 0) {
    const b = r.peek();
    if (b === ESC) return; // 次のコマンドへ

    r.u8();
    // SO/SI: 空白 1 桁の制御セルを置き、DBCS モードを切り替える（桁位置維持）
    if (b === SO) {
      buf.setShift(addr++, "so");
      dbcsMode = true;
      continue;
    }
    if (b === SI) {
      buf.setShift(addr++, "si");
      dbcsMode = false;
      continue;
    }
    if (isAttribute(b)) {
      buf.setAttr(addr++, b);
      dbcsMode = false; // 属性桁で DBCS 連続は切れる
      continue;
    }
    if (dbcsMode && codec.decodeDbcsPair && b >= 0x40) {
      // DBCS 2 バイトを lead/tail の 2 桁に配置
      const b2 = r.u8();
      buf.setDbcs(addr, String.fromCharCode(codec.decodeDbcsPair(b, b2)), b, b2);
      addr += 2;
      continue;
    }
    if (b >= 0x40) {
      buf.setChar(addr, String.fromCharCode(codec.decodeByte(b)), b);
      addr++;
      continue;
    }
    if (b === 0x00) {
      // NUL は表示データ（ブランク）。フィールド初期値等でインラインに現れる
      buf.eraseRange(addr, addr);
      addr++;
      continue;
    }
    switch (b) {
      case ORDER.SBA:
        addr = buf.addrOf(r.u8(), r.u8());
        break;
      case ORDER.IC:
      case ORDER.MC:
        // 01 では IC/MC とも「カーソル位置の設定」として扱う（IC_ULOCK の厳密な扱いは必要時に拡張）
        buf.cursorAddr = buf.addrOf(r.u8(), r.u8());
        result.cursorSet = true;
        break;
      case ORDER.RA: {
        const target = buf.addrOf(r.u8(), r.u8());
        const fill = r.u8();
        if (target < addr) {
          throw new As400Error("PROTOCOL_ERROR", `RA target ${target} < current ${addr}`);
        }
        for (; addr <= target; addr++) {
          if (fill === 0x00) buf.eraseRange(addr, addr);
          else if (isAttribute(fill)) buf.setAttr(addr, fill);
          else buf.setChar(addr, String.fromCharCode(codec.decodeByte(fill)));
        }
        break;
      }
      case ORDER.EA: {
        // EA = 行 桁 length [属性タイプ×(length-1)]（length=2〜5。SC30-3533 / tn5250 erase_to_address）
        const target = buf.addrOf(r.u8(), r.u8());
        const len = r.u8();
        if (len < 2 || len > 5) {
          warn(`invalid EA length ${len} — discarding rest of record`);
          r.skip(r.remaining);
          return;
        }
        r.skip(len - 1); // 属性タイプバイト群（未対応。全消去として扱う）
        if (target < addr) {
          throw new As400Error("PROTOCOL_ERROR", `EA target ${target} < current ${addr}`);
        }
        // 消去は target を含む（tn5250 erase_region と一致）。再開アドレスは tn5250 に合わせ target
        buf.eraseRange(addr, target);
        addr = target;
        break;
      }
      case ORDER.SOH: {
        // フォーマットテーブルの開始: 既存フィールドをクリアし、エラー行等のヘッダを読み飛ばす
        const len = r.u8();
        r.skip(len);
        buf.clearFormatTable();
        break;
      }
      case ORDER.TD: {
        const len = r.u16();
        const bytes = r.bytes(len);
        for (const tb of bytes) {
          buf.setChar(addr++, String.fromCharCode(codec.decodeByte(tb)));
        }
        break;
      }
      case ORDER.SF: {
        addr = applySf(r, buf, addr);
        break;
      }
      case ORDER.WDSF: {
        applyWdsf(r, buf, codec, addr, warn);
        break;
      }
      default:
        warn(`unknown order 0x${b.toString(16)} — discarding rest of record`);
        // オーダー長が不明なため、このレコードの残りは安全に読めない
        r.skip(r.remaining);
        return;
    }
  }
}

/**
 * WDSF オーダー（0x15）: 拡張 5250 GUI 構造体（Create Window / Define Selection Field / Scroll Bar 等）。
 * 構造は [LL(2, 自身含む)] [class(1)=0xD9] [type(1)] [body...]。位置はデータストリームの現在アドレス。
 */
function applyWdsf(
  r: ByteReader,
  buf: ScreenBuffer,
  codec: Codec,
  addr: number,
  warn: WarnFn
): void {
  const len = r.u16();
  if (len < 4 || len - 2 > r.remaining) {
    warn(`invalid WDSF length ${len} — discarding rest of record`);
    r.skip(r.remaining);
    return;
  }
  const sf = r.bytes(len - 2); // [class, type, ...body]
  const { row, col } = buf.rowColOf(addr);
  let event;
  try {
    event = parseWdsf(sf, (b) => codec.decodeByte(b));
  } catch {
    warn("malformed WDSF structured field — ignored");
    return;
  }
  switch (event.kind) {
    case "selection":
      buf.addSelectionField(event.field, row, col);
      break;
    case "window":
      buf.addWindow(event.window, row, col);
      break;
    case "scrollbar":
      buf.addScrollBar(event.scrollbar, row, col);
      break;
    case "remove-selection":
      buf.removeSelectionField(row, col);
      break;
    case "remove-window":
      buf.removeWindow(row, col);
      break;
    case "remove-scrollbar":
      buf.removeScrollBar(row, col);
      break;
    case "remove-all":
      buf.clearGui();
      break;
    case "unknown":
      warn(`unhandled WDSF type 0x${event.type.toString(16)} — ignored`);
      break;
  }
}

/** SF オーダー: [FFW(2)] [FCW(2)*] attr(1) length(2)。FFW 省略時は出力専用（フィールド登録なし） */
function applySf(r: ByteReader, buf: ScreenBuffer, addr: number): number {
  const first = r.peek();
  if (isAttribute(first)) {
    // FFW なし = 出力専用フィールド定義: 属性と長さのみ（フォーマットテーブルに載せない）
    const attr = r.u8();
    r.u16(); // length（表示専用のため未使用）
    buf.setAttr(addr, attr);
    return addr + 1;
  }
  const ffw = r.u16();
  if ((ffw & 0xc000) !== 0x4000) {
    throw new As400Error("PROTOCOL_ERROR", `invalid FFW 0x${ffw.toString(16)}`);
  }
  // FCW（上位 2 ビットが 10）: DBCS 種別等を解釈（SC30-3533 / tn5250 の ideographic FCW）
  let dbcsType: "pure" | "open" | "either" | undefined;
  while (r.remaining >= 2 && (r.peek() & 0xc0) === 0x80) {
    const fcw = r.u16();
    if (fcw === 0x8200) dbcsType = "pure"; // ideographic-only
    else if (fcw === 0x8240) dbcsType = "either"; // ideographic-either
    else if (fcw === 0x8280 || fcw === 0x82c0) dbcsType = "open"; // ideographic-open
  }
  const attr = r.u8();
  const length = r.u16();
  buf.setAttr(addr, attr);
  const fieldStart = addr + 1;
  buf.addField(fieldStart, length, ffw, attr, dbcsType);
  return fieldStart;
}

/**
 * WRITE STRUCTURED FIELD（ホスト → クライアント）。5250 QUERY（class 0xD9 / type 0x70）を検出したら
 * true を返す（呼び出し側が Query Reply を送る）。その他の SF は読み飛ばす（subtask 04 で拡張）。
 */
function applyStructuredField(r: ByteReader, warn: WarnFn): boolean {
  let isQuery = false;
  while (r.remaining >= 2) {
    if (r.peek() === ESC) break; // 次のコマンド
    const len = r.u16();
    if (len < 2) {
      warn(`invalid structured field length ${len}`);
      return isQuery;
    }
    const bodyLen = len - 2;
    if (r.remaining < bodyLen) {
      warn(`structured field truncated (need ${bodyLen}, have ${r.remaining})`);
      return isQuery;
    }
    const body = r.bytes(bodyLen);
    // body[0]=class, body[1]=type
    if (body[0] === 0xd9 && body[1] === 0x70) isQuery = true;
  }
  return isQuery;
}

/** WRITE ERROR CODE: エラー行のメッセージを systemMessage として保持する（表示行への描画は簡略化） */
function applyWriteErrorCode(r: ByteReader, buf: ScreenBuffer, codec: Codec): void {
  let msg = "";
  while (r.remaining > 0 && r.peek() !== ESC) {
    const b = r.u8();
    if (b >= 0x40) msg += String.fromCharCode(codec.decodeByte(b));
    else if (b === ORDER.IC || b === ORDER.SBA || b === ORDER.MC) r.skip(2);
    // その他の制御は読み飛ばす
  }
  const trimmed = msg.trim();
  if (trimmed !== "") buf.systemMessage = trimmed;
}
