/**
 * database ホストサーバーのデータストリーム。
 *
 * signon と**同じ 20 バイトヘッダー**を持つが、その後ろに **20 バイトの template** が付く
 * （signon は 4 バイト＝戻りコードのみ）。パラメータ列は合計 40 バイトの後ろから始まる。
 *
 * 既存 `hostserver/datastream.ts` の `parseReply` はパラメータ開始位置を
 * `HEADER_LEN + templateLen` で求めるため**そのまま流用できる**。
 * ただし template の中身は signon と別物なので、解釈はこのモジュールで行う。
 *
 * 参照: JTOpen(jtopenlite) の DatabaseConnection.writeHeader / writeTemplate /
 *       readReplyHeader に対応する。
 */
import { As400Error } from "../../errors.js";
import { HEADER_LEN } from "../datastream.js";

/** database のサーバー ID（signon は 0xE009） */
export const DB_SERVER_ID = 0xe004;
/** database の応答はすべてこの ReqRep ID で返る */
export const DB_REPLY_ID = 0x2800;
/** 要求・応答の template 長 */
export const DB_TEMPLATE_LEN = 20;

/** 要求 ID */
export const DB_REQ = {
  /** ロケーターから LOB の本体を取る */
  retrieveLobData: 0x1816,
  prepare: 0x1800,
  describe: 0x1801,
  describeParameterMarker: 0x1802,
  prepareAndDescribe: 0x1803,
  openAndDescribe: 0x1804,
  execute: 0x1805,
  executeImmediate: 0x1806,
  commit: 0x1807,
  closeCursor: 0x180a,
  fetch: 0x180b,
  openDescribeFetch: 0x180e,
  setServerAttributes: 0x1f80,
  /** RPB（要求パラメータブロック）作成。作る RPB のハンドルは template に載せる */
  createRpb: 0x1d00,
  deleteRpb: 0x1d02
} as const;

/**
 * ORS（Operational Result Set）bitmap のフラグ。
 *
 * **どのビットを立てるかで応答の中身が変わる**。とくに列定義は
 * `dataFormat` だけでは簡易形式（CP 0x3805）で返り、型・CCSID が取れない。
 * `extendedColumnDescriptors` を併せて立てると拡張形式（CP 0x3812）になる。
 */
export const ORS = {
  sendReplyImmediately: 0x80000000,
  messageId: 0x40000000,
  firstLevelText: 0x20000000,
  secondLevelText: 0x10000000,
  dataFormat: 0x08000000,
  resultData: 0x04000000,
  sqlca: 0x02000000,
  serverAttributes: 0x01000000,
  parameterMarkerFormat: 0x00800000,
  replyRleCompressed: 0x00040000,
  /** 列定義を拡張形式（CP 0x3812）で返させる */
  extendedColumnDescriptors: 0x00020000
} as const;

/**
 * パラメータのコードポイント（database 固有）。
 *
 * **要求側と応答側で同じ番号が別の意味を持つ**ので注意。
 * 例: 0x3807 は要求では「SQL 文テキスト」、応答では「SQLCA」。
 * 推測せず原典（DatabaseConnection の書き出し・解析処理）に合わせること。
 */
export const DB_CP = {
  // --- 要求側 ---
  /** 文名。CCSID 37 の EBCDIC */
  prepareStatementName: 0x3806,
  /** SQL 文テキスト。CCSID 13488（UTF-16） */
  sqlStatementText: 0x3807,
  /** オープン属性（1 バイト） */
  openAttributes: 0x3809,
  /** describe オプション（1 バイト） */
  describeOption: 0x380a,
  /** カーソル名。CCSID 37 の EBCDIC */
  cursorName: 0x380b,
  /** ブロッキング係数（4 バイト） */
  blockingFactor: 0x380c,
  /** SQL 文の種別（2 バイト） */
  sqlStatementType: 0x3812,
  /**
   * サーバー属性の日付書式（2 バイト）。setServerAttributes(0x1F80) でのみ使う。
   * **指定しないとジョブの既定書式になり、年が 2 桁で返る**（例 26-07-18）。
   */
  serverDateFormat: 0x3807,
  /** サーバー属性の時刻書式（2 バイト） */
  serverTimeFormat: 0x3808,
  /**
   * 拡張列記述子オプション（1 バイト）。
   * **これを 0xF1 で指定しないと列定義が拡張形式(0x3812)で返らず、
   * 簡易形式(0x3805)になって列の型・CCSID が取れない。**
   */
  extendedColumnDescriptorOption: 0x3829,
  /** 拡張データ形式の使用（1 バイト）。0xF2 = V5R4 以降の超拡張 */
  useExtendedFormats: 0x3821,
  /** LOB フィールドしきい値（4 バイト）。**これ以下はインラインで丸ごと返る** */
  lobFieldThreshold: 0x3822,
  /** 超拡張列定義 */
  superExtendedDataFormat: 0x3812,
  /** 拡張結果データ */
  extendedResultData: 0x380e,
  /** --- ロケーター経由の LOB 取得（要求 0x1816） --- */
  lobLocatorHandle: 0x3818,
  lobRequestedSize: 0x3819,
  lobStartOffset: 0x381a,
  lobTranslateIndicator: 0x3805,
  lobReturnCurrentLength: 0x3821,
  /** 応答: LOB データ長 */
  lobDataLength: 0x3810,
  /** 応答: LOB 本体（CCSID(2) + 長さ(4) + データ） */
  lobData: 0x380f,

  // --- 応答側 ---
  /**
   * 列定義。実機（IBM i 7.5）は拡張列記述子を要求してもこの CP（元形式）で返す。
   * 型・長さ・位取り・精度・CCSID・列名がすべて含まれるため実用上これで足りる。
   */
  dataFormat: 0x3805,
  /** 拡張結果データ（NULL 指標 ＋ 行データ） */
  /**
   * 応答: 結果データ（NULL 指標 ＋ 行データ）。
   * 実機（IBM i 7.5）は元形式のこの CP で返す（拡張形式 0x380E ではない）。
   */
  resultData: 0x3806,
  /** SQLCA（SQLCODE / SQLSTATE） */
  sqlca: 0x3807
} as const;

/** 応答 template（40 バイトヘッダーの 20〜39） */
export interface DbTemplate {
  orsBitmap: number;
  compressed: boolean;
  returnOrsHandle: number;
  returnDataFunctionId: number;
  requestDataFunctionId: number;
  /** 0 以外がエラー */
  rcClass: number;
  /** rcClass が 0 以外のときの詳細 */
  rcClassReturnCode: number;
}

/**
 * 応答フレームの template を解釈する。
 *
 * フレーム全体の長さ検査と ReqRep ID の確認もここで行う
 * （`parseReply` はパラメータ列だけを見るため、database 固有の妥当性は別に確かめる）。
 */
export function parseDbTemplate(frame: Uint8Array): DbTemplate {
  const minLen = HEADER_LEN + DB_TEMPLATE_LEN;
  if (frame.length < minLen) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `database reply too short: ${frame.length} bytes (need >= ${minLen})`
    );
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const reqRep = view.getUint16(18);
  if (reqRep !== DB_REPLY_ID) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `unexpected database reply id 0x${reqRep.toString(16)} (expected 0x${DB_REPLY_ID.toString(16)})`
    );
  }
  return {
    orsBitmap: view.getUint32(20),
    // compressed は先頭 1 バイトのみ有効。残り 3 バイトは予約
    compressed: view.getUint8(24) !== 0,
    returnOrsHandle: view.getUint16(28),
    returnDataFunctionId: view.getUint16(30),
    requestDataFunctionId: view.getUint16(32),
    rcClass: view.getUint16(34),
    rcClassReturnCode: view.getInt32(36)
  };
}

/** 要求の template を組み立てる（20 バイト） */
export function buildDbTemplate(opts: {
  orsBitmap: number;
  rpbHandle: number;
  parameterCount: number;
  parameterMarkerHandle?: number;
}): Uint8Array {
  const out = new Uint8Array(DB_TEMPLATE_LEN);
  const view = new DataView(out.buffer);
  view.setUint32(0, opts.orsBitmap);
  view.setUint32(4, 0); // 予約
  // 返却 ORS ハンドル・充填 ORS ハンドル（ともに 1）
  view.setUint32(8, 0x00010001);
  view.setUint16(12, 0); // 基準 ORS ハンドル
  view.setUint16(14, opts.rpbHandle);
  view.setUint16(16, opts.parameterMarkerHandle ?? 0);
  view.setUint16(18, opts.parameterCount);
  return out;
}

/**
 * template のエラーを判定する。`rcClass` が 0 以外なら失敗。
 *
 * SQL 固有のエラー（SQLCODE / SQLSTATE）は SQLCA パラメータに載るため、
 * ここでは**プロトコル層の失敗**だけを見る。
 */
export function isDbTemplateError(t: DbTemplate): boolean {
  return t.rcClass !== 0;
}
