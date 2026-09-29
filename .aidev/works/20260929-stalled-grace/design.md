# 仕様: 心拍で切れたときの猶予

## 概要
`SessionManager` に `stalledGraceMs`（既定 `DEFAULT_STALLED_GRACE_MS`＝10 分）を足し、`disposition` の `stalled` が真のときだけ使う。`ws-handler` は心拍の死判定でだけ `stalled: true` を渡す。
猶予の長さは `graceFor(stalled)`: 閉じたとき `reconnectGraceMs`、心拍のとき `max(stalledGraceMs, reconnectGraceMs)`、`reconnectGraceMs <= 0` ならどちらも 0。

## 依拠する既存の事実
- `holdForReconnect`・`disposition`・`decideDisposition`（`holdable` は猶予が有効か。`session-lifetime.ts` は変えない）

## インターフェース
- `SessionManagerOptions.stalledGraceMs`・`holdForReconnect(id, stalled = false)`・`disposition(id, { …, stalled? })`
- CLI: `--stalled-grace <分>`（1〜1440。`parseStalledGrace`）

## 受け入れ基準との対応
- AC1: `test/session-reconnect-grace.test.ts`・`test/ws-lifetime.test.ts`・`test/reconnect-grace-option.test.ts`
- AC2: 実機の比較（既定のサーバー）
