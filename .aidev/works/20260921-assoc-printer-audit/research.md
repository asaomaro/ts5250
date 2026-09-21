# 調査: 監査の付け方

## 判明した事実
- F1: 直接開く `onOpenPrinter` は `withAudit({ op: "ws_open_printer" }, …)`（`packages/server/src/ws-handler.ts`）。監査の型 `AuditEvent` は op・sessionId・result・code・durationMs（`packages/server/src/audit.ts`。値は記録しない）。
- F2: 関連付けの準備は `prepareAssociation`（同ファイル）。結果は `{ printerId?, closeWithLast, issue? }` で、`issue` は invalid / failed / timeout。`withAudit` は例外か MCP のエラー応答でしか `error` にしないので、この形には合わない。

## 実装アンカー
- A1: `prepareAssociation`（`packages/server/src/ws-handler.ts`）— 本体を `startAssociatedPrinter` に分け、外側で `audit()` を 1 回。
