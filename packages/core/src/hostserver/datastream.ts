/**
 * IBM i ホストサーバーのデータストリーム（20 バイト固定ヘッダー ＋ LL/CP 可変長パラメータ）。
 *
 * 5250 のレコード（`protocol/bytes.ts`）とは別形式なので独立させる。全て big-endian。
 *
 * 参照: JTOpen(jtopenlite) の SignonConnection / HostServerConnection が送受信する
 *       データストリームの構造に対応する（コードの移植ではなく、構造に基づく実装）。
 */
import { As400Error } from "../errors.js";

/** ヘッダー長。応答の戻りコードはこの直前（オフセット 20）から 4 バイト */
export const HEADER_LEN = 20;
/**
 * 応答パラメータ列の通常の開始オフセット（ヘッダー 20 ＋ template 4）。
 * 応答の戻りコードは template（長さ 4）として運ばれるため、実際の開始位置は
 * ヘッダーが宣言する template 長から求める（parseReply 参照）。
 */
export const REPLY_PARAM_OFFSET = 24;
/** LL(4) ＋ CP(2) */
export const PARAM_PREFIX_LEN = 6;

/** サーバー ID。ポートではなくデータストリーム上の宛先 */
export const SERVER_ID = {
  signon: 0xe009
} as const;

/** 要求/応答の種別（ReqRep ID） */
export const REQREP = {
  /** 乱数シード交換（signon 以外のサーバー） */
  exchangeRandomSeeds: 0x7001,
  /** サーバー開始（signon 以外のサーバー） */
  startServer: 0x7002,
  /** 交換属性（signon） */
  signonExchangeAttributes: 0x7003,
  /** signon 情報＝認証（signon） */
  signonInfo: 0x7004
} as const;

/** パラメータのコードポイント */
export const CP = {
  version: 0x1101,
  datastreamLevel: 0x1102,
  seed: 0x1103,
  userId: 0x1104,
  password: 0x1105,
  clientCcsid: 0x1113,
  serverCcsid: 0x1114,
  passwordLevel: 0x1119,
  returnErrorMessages: 0x1128,
  jobName: 0x111f
} as const;

/** 1 つの LL/CP パラメータ */
export interface Param {
  cp: number;
  value: Uint8Array;
}

/** 要求データストリームを組み立てる */
export function buildRequest(opts: {
  serverId: number;
  reqRep: number;
  /** ReqRep ID の直後に置く固定長部（signon 情報要求の「暗号化種別」等）。既定は空 */
  template?: Uint8Array;
  params: Param[];
}): Uint8Array {
  const template = opts.template ?? new Uint8Array(0);
  const paramsLen = opts.params.reduce((n, p) => n + PARAM_PREFIX_LEN + p.value.length, 0);
  const total = HEADER_LEN + template.length + paramsLen;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint16(4, 0); // Header ID（ほぼ常に 0）
  view.setUint16(6, opts.serverId);
  view.setUint32(8, 0); // CS instance
  view.setUint32(12, 0); // Correlation ID
  view.setUint16(16, template.length);
  view.setUint16(18, opts.reqRep);

  let pos = HEADER_LEN;
  out.set(template, pos);
  pos += template.length;
  for (const p of opts.params) {
    view.setUint32(pos, PARAM_PREFIX_LEN + p.value.length);
    view.setUint16(pos + 4, p.cp);
    out.set(p.value, pos + PARAM_PREFIX_LEN);
    pos += PARAM_PREFIX_LEN + p.value.length;
  }
  return out;
}

/** 解析済みの応答 */
export interface Reply {
  /** 0 が成功。意味は return-codes.ts で分類する */
  returnCode: number;
  params: Param[];
}

/**
 * 応答データストリームを解析する。
 * 先頭 4 バイトの全体長と実バイト数が一致していることは呼び出し側（フレーム分割）が保証する。
 *
 * 応答は戻りコード 4 バイトを template として運ぶ（実機の交換属性応答も template 長 4）。
 * パラメータ列の開始位置は 24 を決め打ちせず、ヘッダーが宣言する template 長から求める。
 */
export function parseReply(data: Uint8Array): Reply {
  if (data.length < REPLY_PARAM_OFFSET) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `host server reply too short: ${data.length} bytes (need >= ${REPLY_PARAM_OFFSET})`
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const declared = view.getUint32(0);
  if (declared !== data.length) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `host server reply length mismatch: header says ${declared}, got ${data.length}`
    );
  }

  const templateLen = view.getUint16(16);
  if (templateLen < 4) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `host server reply has no return code (template length ${templateLen})`
    );
  }
  const params: Param[] = [];
  let pos = HEADER_LEN + templateLen;
  if (pos > data.length) {
    throw new As400Error(
      "PROTOCOL_ERROR",
      `host server reply template overruns frame (length ${templateLen}, frame ${data.length})`
    );
  }
  while (pos + PARAM_PREFIX_LEN <= data.length) {
    const ll = view.getUint32(pos);
    // LL は自身の 6 バイトを含む。6 未満だと前進できず無限ループになる
    if (ll < PARAM_PREFIX_LEN) {
      throw new As400Error("PROTOCOL_ERROR", `host server reply has bad LL ${ll} at offset ${pos}`);
    }
    if (pos + ll > data.length) {
      throw new As400Error(
        "PROTOCOL_ERROR",
        `host server reply parameter overruns frame (LL=${ll} at offset ${pos}, frame ${data.length})`
      );
    }
    params.push({
      cp: view.getUint16(pos + 4),
      value: data.subarray(pos + PARAM_PREFIX_LEN, pos + ll)
    });
    pos += ll;
  }
  return { returnCode: view.getUint32(HEADER_LEN), params };
}

/** 最初に見つかった当該 CP の値。無ければ undefined */
export function findParam(reply: Reply, cp: number): Uint8Array | undefined {
  return reply.params.find((p) => p.cp === cp)?.value;
}

/** 当該 CP を符号なし整数として読む（1/2/4 バイト）。無ければ undefined */
export function findUint(reply: Reply, cp: number): number | undefined {
  const v = findParam(reply, cp);
  if (v === undefined) return undefined;
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength);
  if (v.length === 1) return view.getUint8(0);
  if (v.length === 2) return view.getUint16(0);
  if (v.length === 4) return view.getUint32(0);
  throw new As400Error("PROTOCOL_ERROR", `unexpected width ${v.length} for CP 0x${cp.toString(16)}`);
}

/** 数値のパラメータ値を作る */
export function uintParam(cp: number, value: number, width: 1 | 2 | 4): Param {
  const v = new Uint8Array(width);
  const view = new DataView(v.buffer);
  if (width === 1) view.setUint8(0, value);
  else if (width === 2) view.setUint16(0, value);
  else view.setUint32(0, value);
  return { cp, value: v };
}
