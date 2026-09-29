# レビュー: 心拍で切れたときの猶予

## タスク点検ログ
- 差分は猶予の長さを分ける経路（`graceFor`・`disposition` の `stalled`・心拍の死判定の 1 行）と起動オプションで、既存の `holdForReconnect`／`decideDisposition` を通す。自前の点検で見た点: `stalled` を渡さない呼び出しは従来どおり（テストで固定）・
  `max` で閉じたときより短くならない・`reconnectGraceMs: 0` の逃げ道を心拍の側も守る（変異で検出）。独立点検の指摘は無し（`taskcheck` は同一セッションでの確認）

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 0）。要件適合: AC1 は単体 12 件（`session-reconnect-grace`・`ws-lifetime`・`reconnect-grace-option`。変異 6 通り検出）、AC2 は実機（既定のまま、心拍に返事しない接続は 260 秒後に同じセッションへ戻れ、閉じた接続は 110 秒後に戻れない）。
  価値・規約適合: 閉じたタブの保持は延ばさない（US2）。半開きの回収が 10 分に遅くなる副作用は D3 に記録
