/**
 * バイトストリーム転送の抽象（design: 3 メソッド＋イベントの薄い抽象に留める）。
 * 実装: TcpTransport（node:net。TLS は subtask 04）/ ReplayTransport（trace 再生・テスト用）。
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
