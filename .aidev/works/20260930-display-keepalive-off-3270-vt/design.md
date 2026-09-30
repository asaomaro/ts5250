# 仕様: 3270・VT の keepAlive

## 概要
各 `tcp.ts` に `keepAlive`（既定 true）を足し、各セッションの `keepAlive`（既定 false）を渡す。サーバーは設定 `keepAlive`（表示のすべて）を 3270・VT の open に運ぶ。

## 依拠する既存の事実
- 5250 の実装（#460）と同じ形（`packages/tn5250/src/transport/tcp.ts`・`session.ts`）
- 3270・VT は独立した `TcpTransport`（各パッケージの `transport/tcp.ts`）

## インターフェース
- `TcpConnectOptions.keepAlive`（tn3270・vt）・`Connect3270Options.keepAlive`・`VtSessionOptions.keepAlive`・`Open3270Options.keepAlive`・`OpenVtOptions.keepAlive`

## 受け入れ基準との対応
- AC1: `packages/tn3270/test/tcp-keepalive.test.ts`・`packages/vt/test/tcp-keepalive.test.ts`
- AC2: `packages/server/test/ws-lifetime.test.ts`
