# 仕様: ホストサーバーの keepAlive

## 概要
`HostConnectionOptions`・`DdmTransportOptions` の `keepAlive`（既定 false）で `setKeepAlive` を呼ぶ。6 種の接続クラスの接続オプションに `keepAlive` を足し、開く関数へ渡す。
サーバーは `hostAuthFrom` で設定の `keepAlive` を運び、解決は種別を問わず `keepAlive` を接続材料に載せる。

## 依拠する既存の事実
- 表示・プリンターの実装（#460〜#462）と同じ設定名 `keepAlive`
- 接続クラスは `signon` のあとに `openHostConnection`/`openDdmTransport`（research F4）

## インターフェース
- `HostConnectionOptions.keepAlive`・`DdmTransportOptions.keepAlive`・各 `*ConnectOptions.keepAlive`・`HostServerAuth.keepAlive`

## 受け入れ基準との対応
- AC1: `packages/hostserver/test/keepalive.test.ts`（14 件）
- AC2: `packages/server/test/host-keepalive.test.ts`・`ws-lifetime.test.ts`
