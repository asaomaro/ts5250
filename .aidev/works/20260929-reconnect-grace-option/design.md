# 仕様: `--reconnect-grace`

## 概要
`main.ts` に `--reconnect-grace <分>`（1〜1440 の整数）を足し、`SessionManager` の `reconnectGraceMs` へ渡す。指定が無ければ渡さず、既定 90 秒のまま。

## 依拠する既存の事実
- `SessionManagerOptions.reconnectGraceMs`（`packages/server/src/session-manager.ts` の `DEFAULT_RECONNECT_GRACE_MS`・コンストラクタ）
- `--idle-timeout` の解釈と同じ流儀（分・範囲・`0` を特別扱いしない）

## インターフェース
- `parseReconnectGrace(raw): number`（ms）・`sessionManagerOptions(args)`（`main.ts`）

## 受け入れ基準との対応
- AC1: `packages/server/test/reconnect-grace-option.test.ts`
- AC2: 実機（サーバーを `--reconnect-grace 10` と既定で起動して比較）
