/**
 * ファイルサーバー（QZLSFILE）のデータストリーム。IFS のファイルを読み書きする。
 *
 * signon 系と同じ 20 バイトヘッダーだが、**テンプレート長が要求ごとに違う**。
 * ファイル名は UTF-16BE（CCSID 1200）で送る。
 *
 * 参照: JTOpen(jtopenlite) の FileConnection に対応する。
 */
import { Tn5250Error } from "../../errors.js";

/** ファイルサーバーのサーバー ID */
export const FILE_SERVER_ID = 0xe002;

/** 要求 ID */
export const FILE_REQ = {
  open: 0x0002,
  read: 0x0003,
  write: 0x0004,
  close: 0x0009,
  listFiles: 0x000a,
  delete: 0x000c,
  exchangeAttributes: 0x0016
} as const;

/** 読み書きの意図（OPEN の access intent） */
export const FILE_ACCESS = { read: 1, write: 2 } as const;

/**
 * 既存ファイルの扱い（OPEN の duplicate file option）。
 *
 * 1 = 無ければ作って開く／有れば開く
 * 8 = 無ければ失敗／有れば開く
 */
export const FILE_DUPLICATE = { createOrOpen: 1, openExisting: 8 } as const;

/** ファイル名のコードポイント */
const CP_FILENAME = 0x0002;
/** 書き込みデータのコードポイント */
const CP_DATA = 0x0020;
/** ファイル名の CCSID（UTF-16BE） */
const FILENAME_CCSID = 1200;

/** UTF-16BE のバイト列 */
function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) v.setUint16(i * 2, text.charCodeAt(i));
  return out;
}

function writeHeader(v: DataView, total: number, templateLen: number, reqId: number): void {
  v.setUint32(0, total);
  v.setUint16(4, 0); // Header ID
  v.setUint16(6, FILE_SERVER_ID);
  v.setUint32(8, 0); // CS instance
  v.setUint32(12, 0); // Correlation ID
  v.setUint16(16, templateLen);
  v.setUint16(18, reqId);
}

/**
 * 交換属性要求（0x0016）。
 *
 * **接続時に必ず送る**——データストリームレベルと使用する CCSID をここで合わせる。
 */
export function buildFileExchangeAttributes(): Uint8Array {
  const total = 42;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, 10, FILE_REQ.exchangeAttributes);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, 8); // データストリームレベル（V5R3 以降）
  // 6 = GMT を使う(4) ＋ PC のパターン一致(2)。POSIX 戻りコード(8) は使わない
  v.setUint16(24, 6);
  v.setUint32(26, 0xffffffff); // 最大データブロック（無制限）
  v.setUint32(30, 12); // CCSID の LL
  v.setUint16(34, 10); // CCSID の CP
  v.setUint16(36, 1200); // 優先 CCSID: UTF-16
  v.setUint16(38, 13488); // 同: UnicodeBig
  v.setUint16(40, 61952); // 同: 旧 IFS UnicodeBig
  return out;
}

export interface OpenFileOptions {
  path: string;
  /** 読み取りか書き込みか */
  access: number;
  /** 無ければ作るか */
  create: boolean;
  /** ファイル内容の CCSID。0 でサーバー既定 */
  dataCcsid?: number;
}

/** ファイルを開く要求（0x0002） */
export function buildOpenFileRequest(opts: OpenFileOptions): Uint8Array {
  if (opts.path.length === 0) {
    throw new Tn5250Error("CONFIG_ERROR", "path is empty");
  }
  const name = utf16be(opts.path);
  // データストリームレベル 16 未満は 36。誤ると全体の配置がずれ、rc=17 等で失敗する
  const templateLength = 36;
  const total = 26 + templateLength + name.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.open);

  let at = 20;
  v.setUint16(at, 0); at += 2; // 連鎖指示
  v.setUint16(at, FILENAME_CCSID); at += 2;
  v.setUint32(at, 1); at += 4; // 作業ディレクトリハンドル
  v.setUint16(at, opts.dataCcsid ?? 0); at += 2;
  v.setUint16(at, opts.access); at += 2;
  v.setUint16(at, 0); at += 2; // 共有: 0 = すべて許可
  v.setUint16(at, 0); at += 2; // データ変換なし
  v.setUint16(at, opts.create ? FILE_DUPLICATE.createOrOpen : FILE_DUPLICATE.openExisting);
  at += 2;
  v.setUint32(at, 0); at += 4; // 作成サイズ
  v.setUint32(at, 0); at += 4; // 固定属性
  v.setUint16(at, 1); at += 2; // 属性リストレベル
  v.setUint32(at, 0); at += 4; // 事前読み取りオフセット
  v.setUint32(at, 0); at += 4; // 事前読み取り長
  // ここまでで 20 + 36 = 56
  v.setUint32(at, name.length + 6); at += 4;
  v.setUint16(at, CP_FILENAME); at += 2;
  out.set(name, at);
  return out;
}

/** 読み取り要求（0x0003） */
export function buildReadRequest(handle: number, offset: number, length: number): Uint8Array {
  const templateLength = 22;
  const total = 20 + templateLength;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.read);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint32(22, handle);
  v.setUint32(26, 0); // 基準オフセット
  v.setUint32(30, offset);
  v.setUint32(34, length);
  v.setUint16(38, 1); // 事前読み取り
  return out;
}

/** 書き込み要求（0x0004） */
export function buildWriteRequest(handle: number, offset: number, data: Uint8Array): Uint8Array {
  // データストリームレベル 16 未満は 18。全体長は 26 + template + データ長
  const templateLength = 18;
  const total = 26 + templateLength + data.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.write);

  let at = 20;
  v.setUint16(at, 0); at += 2; // 連鎖指示
  v.setUint32(at, handle); at += 4;
  v.setUint32(at, 0); at += 4; // 基準オフセット
  v.setUint32(at, offset); at += 4;
  // データフラグ: 3 = 書き込みを確定させる（2 は同期せず即戻る）
  v.setUint16(at, 3); at += 2;
  v.setUint16(at, 0); at += 2; // データ CCSID（0 = 変換しない）
  // ここまでで 20 + 18 = 38
  v.setUint32(at, data.length + 6); at += 4;
  v.setUint16(at, CP_DATA); at += 2;
  out.set(data, at);
  return out;
}

/** 閉じる要求（0x0009） */
export function buildCloseRequest(handle: number): Uint8Array {
  const templateLength = 6;
  const total = 20 + templateLength;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.close);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint32(22, handle);
  return out;
}

/** 削除要求（0x000C） */
export function buildDeleteRequest(path: string): Uint8Array {
  const name = utf16be(path);
  const templateLength = 8;
  const total = 34 + name.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  writeHeader(v, total, templateLength, FILE_REQ.delete);
  v.setUint16(20, 0); // 連鎖指示
  v.setUint16(22, FILENAME_CCSID);
  v.setUint32(24, 1); // 作業ディレクトリハンドル
  v.setUint32(28, name.length + 6);
  v.setUint16(32, CP_FILENAME);
  out.set(name, 34);
  return out;
}

/**
 * エラー応答の ReqRep ID。
 *
 * **応答は ReqRep ID で意味が変わる**——`0x8001` はエラーで、テンプレート先頭が戻りコード。
 * 成功応答（`0x8002` = OPEN 等）は戻りコードを持たず、テンプレート先頭が結果そのもの。
 * ここを取り違えると、ハンドルを戻りコードとして読んでしまう。
 */
export const REPLY_ERROR = 0x8001;

/** 応答の ReqRep ID */
export function replyId(frame: Uint8Array): number {
  if (frame.length < 20) {
    throw new Tn5250Error("PROTOCOL_ERROR", `file server reply too short: ${frame.length} bytes`);
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(18);
}

/**
 * エラー応答なら戻りコードを返す。成功応答なら 0。
 *
 * **テンプレートの先頭 2 バイトは連鎖指示**で、戻りコードはその次（オフセット 22）。
 * 20 を読むと常に 0 に見えて、失敗を成功と誤認する。
 */
export function replyReturnCode(frame: Uint8Array): number {
  if (replyId(frame) !== REPLY_ERROR) return 0;
  if (frame.length < 24) {
    throw new Tn5250Error("PROTOCOL_ERROR", "file server error reply has no return code");
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(22);
}

/** 戻りコードの意味（原典 FileConstants） */
export function fileErrorText(rc: number): string {
  switch (rc) {
    case 2:
      return "File not found";
    case 3:
      return "Path not found";
    case 6:
      return "Invalid handle";
    case 13:
      return "Access denied";
    case 18:
      return "No more files";
    default:
      return `error ${rc}`;
  }
}

/**
 * OPEN 応答（0x8002）のファイルハンドル。
 * 連鎖指示(2) の次から 4 バイト。
 */
export function replyFileHandle(frame: Uint8Array): number {
  if (frame.length < 26) {
    throw new Tn5250Error("PROTOCOL_ERROR", "file server open reply has no handle");
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(22);
}

/** READ 成功応答の ReqRep ID */
export const REPLY_READ = 0x8003;

/**
 * READ 応答からデータを取り出す。
 *
 * **LL/CP 形式ではない**——連鎖指示(2) ＋ CCSID(2) ＋ データ長(4) の後に実データが続き、
 * 実データの長さは「データ長 − 6」。ここを LL/CP と誤解すると 0 バイトになる。
 */
export function readReplyData(frame: Uint8Array): Uint8Array | undefined {
  if (replyId(frame) !== REPLY_READ) return undefined;
  if (frame.length < 28) return undefined;
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  // 20: 連鎖指示(2) / 22: CCSID(2) / 24: データ長(4) / 28: データ
  // データ長には LL/CP の 6 バイトが含まれる。実データはその 6 バイト後ろから始まる
  const declared = v.getUint32(24) - 6;
  if (declared <= 0) return undefined;
  // 配置: 20 連鎖指示(2) / 22 CCSID(2) / 24 データ長(4) / 28 LL・CP 相当(2) / 30 データ
  //
  // 応答が宣言するテンプレート長からは求められない（宣言値とデータ開始位置が一致しない）。
  // 実機で確認した固定配置を使う。**変更するときは必ず実機で往復を確かめること**——
  // テンプレート長から求める形に「整理」して壊した実績がある。
  const dataAt = 30;
  const available = frame.length - dataAt;
  if (available <= 0) return undefined;
  return frame.subarray(dataAt, dataAt + Math.min(declared, available));
}

export { CP_DATA as FILE_CP_DATA };
