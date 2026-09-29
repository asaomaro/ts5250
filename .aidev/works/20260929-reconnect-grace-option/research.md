# 調査: 放置で切れる

## 判明した事実
- F1: サーバーは `ping` を 30 秒ごとに送り、クライアントから何も来ないまま 90 秒を超えると次の巡回で死判定（`packages/server/src/ws-handler.ts` の `startHeartbeat`）。巡回の周期のため実測は約 116 秒。死判定で WebSocket を閉じ、`holdForReconnect` の猶予（`DEFAULT_RECONNECT_GRACE_MS` 90 秒。`session-manager.ts`）に入る。猶予が切れるとセッションを閉じる（`reapHold`）
- F2: 実機で再現（サーバー経由の /ws で、`ping` に返事しない）: 116 秒で `closed reason=heartbeat timeout`、260 秒後の `open { sessionId, resume: true }` は `SESSION_NOT_FOUND`。ブラウザの文言は「セッションは既に終了しています（開き直してください）」（`opMessages.ts` の `NOTICE_BY_ERROR`）
- F3: 猶予は `SessionManagerOptions.reconnectGraceMs` にあったが、起動オプションからは渡せなかった（`main.ts` の `buildDeps` は `idleTimeoutMs` だけ渡していた）
- F4: 猶予は履歴上 2026-09-08（`077761a7`）から在り、ACS parity 対応より前。心拍・TCP keepalive も同様（parity の期間に tcp.ts・心拍は変わっていない）
