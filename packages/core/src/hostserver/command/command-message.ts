/**
 * コマンドサーバーが返すメッセージの解析。
 *
 * 形式が 2 つある。実機（IBM i 7.5・データストリームレベル 11）は **CP 0x1106**
 * （全項目が長さ前置）を返す。CP 0x1102（固定長）は古いサーバー向けで、
 * **実機で観測できていない**——相手が出すものを受ける側なので実装はするが、
 * 検証は合成バイト列の単体テストに限られる。
 *
 * 参照: JTOpen(jtopenlite) の CommandConnection.getMessages に対応する。
 */
import { As400Error } from "../../errors.js";
import { codecForCcsid } from "../../codec/codec.js";
import { MSG_CP, REPLY_MESSAGE_COUNT_OFFSET, REPLY_MESSAGES_OFFSET } from "./command-datastream.js";

/** メッセージ ID・テキストは CCSID 37 の EBCDIC（ジョブの CCSID ではない） */
const MESSAGE_CCSID = 37;

/** 重大度の分類。文言ではなく値で分岐できるようにする */
export type MessageKind = "info" | "warning" | "error" | "severe";

/** IBM i が返したメッセージ */
export interface HostMessage {
  /** 例 "CPF2110" */
  id: string;
  text: string;
  severity: number;
  kind: MessageKind;
  file?: string;
  library?: string;
  help?: string;
}

/**
 * 重大度を分類する。実機では 0（情報）/ 30（エラー）/ 40（重大）を観測した。
 *
 * **成功したコマンドでも重大度 0 のメッセージが返る**（例 CPC2101 "Library list changed."）。
 * メッセージの有無で成否を判断しないこと。
 */
export function classifySeverity(severity: number): MessageKind {
  if (severity >= 40) return "severe";
  if (severity >= 20) return "error";
  if (severity >= 1) return "warning";
  return "info";
}

/** EBCDIC の断片を文字列にする（末尾の空白は落とす） */
function text(bytes: Uint8Array): string {
  return codecForCcsid(MESSAGE_CCSID).decode(bytes).trimEnd();
}

/** 長さ前置の断片を読む簡易カーソル */
class Cursor {
  constructor(
    private readonly data: Uint8Array,
    private pos: number,
    private readonly end: number
  ) {}

  get offset(): number {
    return this.pos;
  }

  private view(): DataView {
    return new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }

  u16(): number {
    this.need(2);
    const v = this.view().getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view().getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view().getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** 長さ(4) ＋ 本体 の断片 */
  lengthPrefixed(): Uint8Array {
    return this.bytes(this.u32());
  }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `command message truncated (need ${n} bytes at offset ${this.pos}, limit ${this.end})`
      );
    }
  }
}

/** CP 0x1106（長さ前置）。実機が返す形式 */
function parseExtended(c: Cursor): HostMessage {
  c.skip(4); // テキスト CCSID
  c.skip(4); // 置換文字列 CCSID
  const severity = c.i16();
  const typeLen = c.u32();
  c.skip(typeLen); // メッセージ種別（本実装では使わない）
  const id = text(c.lengthPrefixed());
  const file = text(c.lengthPrefixed());
  const library = text(c.lengthPrefixed());
  const body = text(c.lengthPrefixed());
  c.lengthPrefixed(); // 置換データ（本実装では使わない）
  const help = text(c.lengthPrefixed());

  return {
    id,
    text: body,
    severity,
    kind: classifySeverity(severity),
    ...(file ? { file } : {}),
    ...(library ? { library } : {}),
    ...(help ? { help } : {})
  };
}

/**
 * CP 0x1102（固定長）。古いサーバー向け。
 * **実機で観測できていない**ため、単体テストのみで担保している。
 */
function parseOriginal(c: Cursor): HostMessage {
  const id = text(c.bytes(7));
  c.skip(2); // メッセージ種別
  const severity = c.i16();
  const file = text(c.bytes(10));
  const library = text(c.bytes(10));
  const substitutionLen = c.u16();
  const textLen = c.u16();
  c.skip(substitutionLen);
  const body = text(c.bytes(textLen));

  return {
    id,
    text: body,
    severity,
    kind: classifySeverity(severity),
    ...(file ? { file } : {}),
    ...(library ? { library } : {})
  };
}

/**
 * 応答フレームからメッセージ列を取り出す。
 *
 * 未知のコードポイントは**読み飛ばす**（解析全体を落とさない）。
 */
export function parseMessages(frame: Uint8Array): HostMessage[] {
  if (frame.length < REPLY_MESSAGES_OFFSET) return [];
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const count = v.getUint16(REPLY_MESSAGE_COUNT_OFFSET);

  const messages: HostMessage[] = [];
  let pos = REPLY_MESSAGES_OFFSET;
  for (let i = 0; i < count; i++) {
    if (pos + 6 > frame.length) break;
    const ll = v.getUint32(pos);
    // LL は自身の 6 バイトを含む。6 未満だと前進できず無限ループになる
    if (ll < 6 || pos + ll > frame.length) break;
    const cp = v.getUint16(pos + 4);
    const c = new Cursor(frame, pos + 6, pos + ll);
    try {
      if (cp === MSG_CP.extended) messages.push(parseExtended(c));
      else if (cp === MSG_CP.original) messages.push(parseOriginal(c));
      // 未知の CP は黙って読み飛ばす
    } catch {
      // 1 件の解析失敗で全体を捨てない
    }
    pos += ll;
  }
  return messages;
}

/** 表示・ログ用の要約 */
export function describeMessage(m: HostMessage): string {
  return `${m.id} [${m.kind}/${m.severity}] ${m.text}`;
}
