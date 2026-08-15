import { childLog } from "@ts5250/base";
import { ByteReader } from "./bytes.js";
import { CMD3270, ORDER, WCC, XA, SO, SI, normalizeCommand } from "./constants.js";
import { decodeAddress } from "./address.js";
import type { Screen3270 } from "../screen/buffer.js";
import { splitStructuredFields, asQueryRequest, SF_TYPE, type QueryRequest } from "./query-reply.js";

const log = childLog({ component: "tn3270-inbound" });

/**
 * ホスト → 端末のデータストリームを `Screen3270` に適用する。
 *
 * **状態を持たない**（design D9）。状態は `Screen3270` とセッションだけが持つ。
 * パーサに状態を持たせると trace の replay と実接続で挙動が分かれる余地ができるので、
 * ここは「バッファを受け取って書き換えるだけ」に留める——**replay がそのまま単体テストになる**。
 *
 * コマンド・オーダーのコードはすべて実測で確定した（`protocol/constants.ts` 参照）。
 */

/** ホストが応答を求めてきたときの種別（応答の生成は `outbound.ts` = subtask 03） */
export type ReadRequest = "read-buffer" | "read-modified" | "read-modified-all" | null;

export interface UnknownItem {
  kind: "command" | "order" | "structured-field";
  byte: number;
  offset: number;
}

export interface InboundResult {
  /** WCC の restore。**キーボードのロックが解ける**（セッションの状態機械が使う） */
  keyboardRestored: boolean;
  /** WCC の resetMDT */
  resetMdt: boolean;
  alarm: boolean;
  /** ホストが応答を求めた場合 */
  read: ReadRequest;
  /** 構造化フィールドの要求（Query）。**応答しないとホストが画面を出さない** */
  structuredField?: QueryRequest;
  /** 未知のコマンド／オーダー。**落とさずに記録する**（spec のエラー処理） */
  unknown: UnknownItem[];
}

export function applyInbound(screen: Screen3270, record: Uint8Array): InboundResult {
  const r = new ByteReader(record);
  const result: InboundResult = {
    keyboardRestored: false,
    resetMdt: false,
    alarm: false,
    read: null,
    unknown: []
  };
  if (record.length === 0) return result;

  // **系統を吸収してから分岐する**（EBCDIC 系 / SNA 系。constants.ts 参照）
  const rawCommand = r.u8();
  const command = normalizeCommand(rawCommand);
  switch (command) {
    case CMD3270.ERASE_WRITE:
      screen.resize(false); // 標準 24x80（spec D5）
      applyWcc(screen, r.u8(), result);
      break;
    case CMD3270.ERASE_WRITE_ALTERNATE:
      screen.resize(true); // 代替サイズ（spec D5）
      applyWcc(screen, r.u8(), result);
      break;
    case CMD3270.WRITE:
      applyWcc(screen, r.u8(), result);
      break;
    case CMD3270.ERASE_ALL_UNPROTECTED:
      screen.eraseUnprotected();
      screen.setKeyboardLocked(false);
      result.keyboardRestored = true;
      return result; // WCC もオーダーも無い
    case CMD3270.READ_BUFFER:
      result.read = "read-buffer";
      return result;
    case CMD3270.READ_MODIFIED:
      result.read = "read-modified";
      return result;
    case CMD3270.READ_MODIFIED_ALL:
      result.read = "read-modified-all";
      return result;
    case CMD3270.WRITE_STRUCTURED_FIELD: {
      // **IBM i は接続直後に Query を撃ち、応答を待ってから画面を出す**（実測）。
      // 画面本体も `Outbound 3270DS` として**この封筒に入って**来るので、
      // ここを読み飛ばすと画面が一切出ない。
      // **1 レコードに複数の SF が入る**（画面の後ろに Set Reply Mode が続く形を実測）。
      for (const sf of splitStructuredFields(record)) {
        const q = asQueryRequest(sf);
        if (q !== null) {
          result.structuredField = q;
          continue;
        }
        if (sf.type === SF_TYPE.OUTBOUND_3270DS) {
          // 封筒を開けて中身を適用する。body の先頭 1 バイトはパーティション ID
          const inner = sf.body.subarray(1);
          if (inner.length > 0) {
            const r = applyInbound(screen, inner);
            result.keyboardRestored ||= r.keyboardRestored;
            result.resetMdt ||= r.resetMdt;
            result.alarm ||= r.alarm;
            result.unknown.push(...r.unknown);
            if (r.read !== null) result.read = r.read;
          }
          continue;
        }
        if (sf.type === SF_TYPE.SET_REPLY_MODE) continue; // 返すものは無い
        result.unknown.push({ kind: "structured-field", byte: sf.type, offset: 0 });
      }
      return result;
    }
    default:
      result.unknown.push({ kind: "command", byte: rawCommand, offset: 0 });
      log.debug(`unknown 3270 command 0x${rawCommand.toString(16)}`);
      return result;
  }

  applyOrders(screen, r, result);
  return result;
}

function applyWcc(screen: Screen3270, wcc: number, result: InboundResult): void {
  if ((wcc & WCC.RESET_MDT) !== 0) {
    screen.resetAllMdt();
    result.resetMdt = true;
  }
  if ((wcc & WCC.ALARM) !== 0) result.alarm = true;
  if ((wcc & WCC.RESTORE) !== 0) {
    screen.setKeyboardLocked(false);
    result.keyboardRestored = true;
  }
}

function applyOrders(screen: Screen3270, r: ByteReader, result: InboundResult): void {
  let addr = 0;
  // SA が設定した拡張属性は**以降の文字に効く**。record 内だけのローカル状態
  let curColor = 0;
  let curHilite = 0;
  /**
   * DBCS 区間（SO 〜 SI）の中か。
   *
   * **区間内のバイトはオーダーとして解釈してはならない。** DBCS のバイト対は
   * 0x40 未満の値も取りうるので、「0x40 未満は制御コード」という判定を素通しさせると
   * 日本語の途中でオーダー扱いされて画面が壊れる。
   */
  let inDbcs = false;

  const put = (byte: number): void => {
    screen.writeChar(addr, byte);
    screen.setExt(addr, curColor, curHilite);
    addr = screen.wrap(addr + 1);
  };

  while (!r.atEnd) {
    const offset = r.offset;
    const b = r.u8();
    // **DBCS 区間の中はデータとして素通しする**（SI が来るまでオーダー解釈しない）
    if (inDbcs && b !== SI) {
      put(b);
      continue;
    }
    switch (b) {
      case SO:
        // **SO / SI はオーダーではなくデータ**。バッファに 1 桁として置く（実測）
        inDbcs = true;
        put(b);
        break;
      case SI:
        inDbcs = false;
        put(b);
        break;
      case ORDER.SBA:
        addr = screen.wrap(decodeAddress(r.u8(), r.u8(), screen.size));
        break;
      case ORDER.SF: {
        const attr = r.u8();
        screen.startField(addr, attr);
        addr = screen.wrap(addr + 1); // **属性は 1 桁を占める**
        curColor = 0;
        curHilite = 0;
        break;
      }
      case ORDER.SFE: {
        const pairs = r.u8();
        let attr = 0;
        let color = 0;
        let hilite = 0;
        for (let i = 0; i < pairs; i++) {
          const type = r.u8();
          const value = r.u8();
          if (type === XA.BASIC) attr = value;
          else if (type === XA.FOREGROUND) color = value;
          else if (type === XA.HIGHLIGHT) hilite = value;
          // 未知の type は無視（落とさない）
        }
        screen.startField(addr, attr);
        screen.setExt(addr, color, hilite);
        addr = screen.wrap(addr + 1);
        curColor = color;
        curHilite = hilite;
        break;
      }
      case ORDER.SA: {
        const type = r.u8();
        const value = r.u8();
        if (type === XA.FOREGROUND) curColor = value;
        else if (type === XA.HIGHLIGHT) curHilite = value;
        else if (type === XA.BASIC && value === 0) {
          curColor = 0;
          curHilite = 0;
        }
        break;
      }
      case ORDER.MF: {
        const pairs = r.u8();
        for (let i = 0; i < pairs; i++) {
          const type = r.u8();
          const value = r.u8();
          // MF は**既にある属性桁**を書き換える
          if (type === XA.BASIC && screen.isAttrPos(addr)) screen.startField(addr, value);
          else if (type === XA.FOREGROUND) screen.setExt(addr, value, screen.extAt(addr).hilite);
          else if (type === XA.HIGHLIGHT) screen.setExt(addr, screen.extAt(addr).color, value);
        }
        addr = screen.wrap(addr + 1);
        break;
      }
      case ORDER.IC:
        screen.setCursor(addr);
        break;
      case ORDER.PT:
        addr = screen.nextUnprotected(addr);
        break;
      case ORDER.RA: {
        const stop = screen.wrap(decodeAddress(r.u8(), r.u8(), screen.size));
        const ch = r.u8();
        // **環状に**stop の手前まで埋める。stop == addr なら画面 1 周
        let p = addr;
        const n = screen.size;
        for (let i = 0; i < n; i++) {
          screen.writeChar(p, ch);
          screen.setExt(p, curColor, curHilite);
          p = screen.wrap(p + 1);
          if (p === stop) break;
        }
        addr = stop;
        break;
      }
      case ORDER.EUA: {
        const stop = screen.wrap(decodeAddress(r.u8(), r.u8(), screen.size));
        screen.eraseUnprotected(addr, stop);
        addr = stop;
        break;
      }
      case ORDER.GE: {
        // **次の 1 バイトは代替文字集合**（APL 記号・罫線素片）。
        // 通常の EBCDIC として置くと `GE 0xC1` が `A` になってしまう（実測で発覚）
        screen.writeCharGe(addr, r.u8());
        screen.setExt(addr, curColor, curHilite);
        addr = screen.wrap(addr + 1);
        break;
      }
      default:
        if (b < 0x40 && b !== 0x00) {
          // 0x40 未満は制御コードの領域。**未知のオーダーとして記録し読み飛ばす**
          result.unknown.push({ kind: "order", byte: b, offset });
          log.debug(`unknown 3270 order 0x${b.toString(16)} at ${offset}`);
        } else {
          put(b);
        }
        break;
    }
  }
}
