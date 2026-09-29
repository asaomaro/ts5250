# レビュー: `--reconnect-grace`

## タスク点検ログ
- 差分は起動オプションの解釈と受け渡し・単体・README のみで小さく、既存の `reconnectGraceMs`（`SessionManager`）を通すだけ。点検で直した指摘は無い（`taskcheck` は実施していない: 自前の差分が起動オプションの解釈に限られるため）

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 0）。要件適合: AC1 は単体 5 件（変異 3 通り検出）、AC2 は実機の比較（既定は `SESSION_NOT_FOUND`・`--reconnect-grace 10` は同じセッションへ繋ぎ直せた）。
  価値適合: 放置から戻ったタブが同じセッションを続けられる。規約適合: 既定は変えない（D1）
