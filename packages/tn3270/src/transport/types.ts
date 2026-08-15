/**
 * バイトストリーム転送の抽象（design D2: 3 メソッド＋イベントの薄い抽象に留める）。
 *
 * `@ts5250/tn5250` の同名インターフェースと**意図的に同型**にしてあるが、共有しない。
 * `base` へ降ろすと `base` が `node:net` / `node:tls` を持つことになり、
 * 「`base` は依存ゼロ」という不変条件（`dependency-direction.test.ts` が検査）を壊すため。
 * 括るとしても `base` ではなく別パッケージを起こす話になる（decisions D2）。
 *
 * 実装: `TcpTransport`（node:net / node:tls）/ `ReplayTransport`（trace 再生・subtask 05）。
 */
export interface Transport {
  send(data: Uint8Array): void;
  close(): void;
  onData(fn: (data: Uint8Array) => void): void;
  /** 相手方切断・close() の双方で 1 回だけ発火する */
  onClose(fn: (reason: string) => void): void;
  onError(fn: (err: Error) => void): void;
  /** ハンドラ登録後にデータ供給を開始する実装（ReplayTransport 等）のためのフック */
  start?(): void;
}
