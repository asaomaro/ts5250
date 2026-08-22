/**
 * バイトストリーム転送の抽象。
 *
 * `@ts5250/tn5250` / `@ts5250/tn3270` の同名インターフェースと**意図的に同型**にしてあるが、
 * 共有しない。`base` へ降ろすと `base` が `node:net` / `node:tls` を持つことになり、
 * 「`base` は依存ゼロ」という不変条件（`dependency-direction.test.ts` が検査）を壊すため。
 *
 * **`node:*` を import してよいのは `transport/` だけ**（AGENTS.md の層規約。
 * `eslint.config.js` が `packages/vt/src/transport/**` を ignores に置いて担保している）。
 *
 * 実装: `TcpTransport`（node:net / node:tls）/ `ReplayTransport`（trace 再生）。
 */
export interface Transport {
  send(data: Uint8Array): void;
  close(): void;
  onData(fn: (data: Uint8Array) => void): void;
  /** 相手方切断・`close()` の双方で 1 回だけ発火する */
  onClose(fn: (reason: string) => void): void;
  onError(fn: (err: Error) => void): void;
  /** ハンドラ登録後にデータ供給を開始する実装（`ReplayTransport` 等）のためのフック */
  start?(): void;
}
