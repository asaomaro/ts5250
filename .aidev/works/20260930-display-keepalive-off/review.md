# レビュー: 表示セッションの keepAlive

## タスク点検ログ
- 差分は `TcpConnectOptions` の既定を変えず、表示の 5250 だけが `false` を渡す形。点検で見た点: プリンター・3270・VT の呼び出しは何も渡さず従来どおり（テストで既定 true を固定）・
  セッション設定は表示の 5250 だけ載せる（解決の段のテストと変異で検出）・再接続（`tryReconnect` → `openTcp`）も同じ入口を通る。独立点検の指摘は無し（`taskcheck` は同一セッションでの確認）

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 0）。要件適合: AC1 は `tcp-keepalive.test.ts`（4 件）、AC2 は `ws-lifetime.test.ts`（4 件）。変異 7 通り検出。
  価値適合: 一時的な回線断で操作していないセッションが落ちない（ACS と同じ）。規約適合: 原則 1（ACS が正典。`SESSION_KEEPALIVE` の既定 false を原典で確認）。
  ⚠ 実機の LAN ケーブルの抜き差しは再現していない（下の「未検証の穴」）
