# 仕様: 表示セッションの keepAlive

## 概要
`TcpConnectOptions.keepAlive`（既定 true のまま）を足し、`Session5250` の `keepAlive`（既定 false）を渡す。サーバーはセッション設定 `keepAlive`（表示の 5250 だけ）を `OpenOptions` へ運ぶ。プリンター・3270・VT は変えない。

## 依拠する既存の事実
- `TcpTransport.connect` の呼び出し元: 5250 表示（`session.ts` の `openTcp`）・プリンター（`printer-session.ts`）・3270・VT
- 表示の設定は `{...target.connect}` で `Session5250.connect` へ渡る（`ws-handler.ts`・`session-manager.ts`）

## インターフェース
- `TcpConnectOptions.keepAlive?: boolean`・`Session5250` の `keepAlive?: boolean`・セッション設定 `keepAlive`（`config-types.ts`）

## 受け入れ基準との対応
- AC1: `packages/tn5250/test/tcp-keepalive.test.ts`
- AC2: `packages/server/test/ws-lifetime.test.ts`
