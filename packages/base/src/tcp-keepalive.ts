/** TCP の生存確認の設定。端末プロトコルに属さないため各ライブラリで共有する。 */
export interface TcpKeepAliveOptions {
  /** 最後の通信から最初の確認まで（ms、秒単位）。既定 60000 */
  initialDelayMs?: number | undefined;
  /** 応答がない場合の確認間隔（ms、秒単位）。既定 1000 */
  intervalMs?: number | undefined;
  /** 応答なしを許容する確認回数。既定 10 */
  count?: number | undefined;
}

/** UI と通信層が共有する既定値。既存の既定の動作を維持する。 */
export const TCP_KEEPALIVE_DEFAULTS = { initialDelayMs: 60000, intervalMs: 1000, count: 10 } as const;

/** Node 26.4 の引数へ変換する。無効値や秒未満の切り捨てで設定の意味を変えない。 */
export function tcpKeepAliveArgs(options: TcpKeepAliveOptions = {}): [true, number, number, number] {
  const initialDelayMs = options.initialDelayMs ?? TCP_KEEPALIVE_DEFAULTS.initialDelayMs;
  const intervalMs = options.intervalMs ?? TCP_KEEPALIVE_DEFAULTS.intervalMs;
  const count = options.count ?? TCP_KEEPALIVE_DEFAULTS.count;
  for (const value of [initialDelayMs, intervalMs]) {
    if (!Number.isInteger(value) || value < 1000 || value > 32767000 || value % 1000 !== 0) {
      throw new RangeError("TCP キープアライブの時間は 1000〜32767000 ms の秒単位で指定してください");
    }
  }
  if (!Number.isInteger(count) || count < 1 || count > 127) throw new RangeError("TCP キープアライブの回数は 1〜127 で指定してください");
  return [true, initialDelayMs, intervalMs, count];
}
