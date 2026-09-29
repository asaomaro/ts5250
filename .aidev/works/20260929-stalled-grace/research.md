# 調査: 猶予の種類

## 判明した事実
- F1: 切れ方は 2 つに分かれる。WebSocket が閉じた（`ws-handler.ts` の `dispose("websocket closed", { transportLost: true })`）と、心拍の死判定（`dispose("heartbeat timeout", …)`）。前者はタブを閉じた・回線の瞬断で、後者は返事が無い（タブが止まった・半開き）
- F2: 両方が同じ `holdForReconnect`（猶予 90 秒。`DEFAULT_RECONNECT_GRACE_MS`）に入る。猶予中も `maxSessions` の枠・ホストの装置とジョブを掴む（`session-manager.ts`）
- F3: 実機（`20260929-reconnect-grace-option` の再現）: 心拍に返事しない接続は約 116 秒で切れ、猶予 90 秒の後に閉じる。260 秒後の再接続は `SESSION_NOT_FOUND`
- F4: 90 秒はブラウザの再接続の最悪 87.2 秒を覆う値（`20260908-session-survives-disconnect` D12）で、放置から戻る場合は想定していなかった
