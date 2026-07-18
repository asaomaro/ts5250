/**
 * ポートマッパー（TCP 449 / QSYSWRK の QZSOMAPD）へのサービス名→ポート問い合わせ。
 *
 * プロトコルは極めて素朴で、サービス名を ASCII で送ると 1 バイトの状態と 4 バイトのポートが返る。
 * **1 リクエストにつき 1 ソケット**（サーバーが 1 回しか応答しないため使い捨てる）。
 *
 * 参照: JTOpen(jtopenlite) の PortMapper に対応する
 *       （コードの移植ではなく、要求/応答の形式に基づく実装）。
 */
import { queryPortMapper } from "../transport/host-connection.js";
import { Tn5250Error } from "../errors.js";

/** ポートマッパーの待ち受けポート */
export const PORT_MAPPER_PORT = 449;

/** 応答の先頭 1 バイト。これ以外は失敗 */
const RESPONSE_OK = 0x2b;
const RESPONSE_LEN = 5;

/** 問い合わせ可能なホストサーバー */
export type HostService = "signon" | "database" | "command" | "file" | "ddm";

/**
 * ポートマッパーに渡すサービス名。
 *
 * **TLS では末尾に "-s" を付ける**（`as-signon` は平文 8476、`as-signon-s` が TLS 9476）。
 * 付け忘れると平文ポートが返り、そこへ TLS を張ろうとして接続が切られる。
 */
export const SERVICE_NAME: Record<HostService, string> = {
  signon: "as-signon",
  database: "as-database",
  command: "as-rmtcmd",
  file: "as-file",
  ddm: "drda"
};

/** ポートマッパーを使わない場合の既定ポート（平文 / TLS） */
export const DEFAULT_PORT: Record<HostService, { plain: number; tls: number }> = {
  signon: { plain: 8476, tls: 9476 },
  database: { plain: 8471, tls: 9471 },
  command: { plain: 8475, tls: 9475 },
  file: { plain: 8473, tls: 9473 },
  // DDM/DRDA は他と違い 8471 系ではなく DRDA 標準ポート 446（TLS は 448）
  ddm: { plain: 446, tls: 448 }
};

export interface ResolvePortOptions {
  timeoutMs?: number;
  /** TLS 用のポートを問い合わせる（サービス名に "-s" を付ける）。既定 false */
  tls?: boolean;
  /**
   * ポートマッパー自身の待ち受けポート。既定 449。
   * SSH トンネル等で転送している場合に指定する。
   */
  mapperPort?: number;
}

/**
 * サービスの待ち受けポートを問い合わせる。
 *
 * ポートマッパー自体は TLS を張らない（返るポート番号を使って本接続側で TLS を張る）。
 */
export async function resolveServicePort(
  host: string,
  service: HostService,
  opts: ResolvePortOptions = {}
): Promise<number> {
  // TLS では末尾に "-s" を付けないと平文ポートが返る
  const name = opts.tls ? `${SERVICE_NAME[service]}-s` : SERVICE_NAME[service];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const mapperPort = opts.mapperPort ?? PORT_MAPPER_PORT;

  const response = await queryPortMapper(host, name, mapperPort, timeoutMs, RESPONSE_LEN);
  return parseMapperResponse(response, name, host);
}

/** ポートマッパー応答（先頭 1 バイトの状態 ＋ 4 バイトのポート）を解釈する */
export function parseMapperResponse(response: Uint8Array, name: string, host: string): number {
  if (response.length < RESPONSE_LEN) {
    throw new Tn5250Error(
      "PROTOCOL_ERROR",
      `port mapper response too short: ${response.length} bytes (service "${name}")`
    );
  }
  if (response[0] !== RESPONSE_OK) {
    throw new Tn5250Error(
      "PROTOCOL_ERROR",
      `port mapper rejected service "${name}" on ${host} (status 0x${response[0]?.toString(16)})`
    );
  }
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
  const port = view.getUint32(1);
  if (port <= 0 || port > 65535) {
    throw new Tn5250Error(
      "PROTOCOL_ERROR",
      `port mapper returned invalid port ${port} for "${name}"`
    );
  }
  return port;
}
