# 仕様: プリンターの keepAlive

## 概要
`PrinterConnectOptions.keepAlive`（既定 false）を `TcpTransport.connect` の `keepAlive` に渡す。サーバーはセッション設定 `keepAlive`（表示とプリンター）をプリンターの open（`printerOptsFrom`）へ運ぶ。

## 依拠する既存の事実
- 表示の実装（#460・#461）と同じ形（`Session5250`・`transport/tcp.ts` の `keepAlive`）
- `printerOptsFrom` はキーごとの手写し（転記漏れに注意という注記がある）

## インターフェース
- `PrinterConnectOptions.keepAlive`・`OpenPrinterOptions.keepAlive`・セッション設定 `keepAlive`（プリンターにも効く）

## 受け入れ基準との対応
- AC1: `packages/tn5250/test/tcp-keepalive.test.ts`
- AC2: `packages/server/test/ws-lifetime.test.ts`
