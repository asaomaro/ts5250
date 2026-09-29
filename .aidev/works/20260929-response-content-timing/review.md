# レビュー: READ SCREEN の応答の中身のタイミング

## タスク点検ログ
- (cross・委譲) 確認して問題なし: 命令の時点で組んだレコードは同じレコードの前の命令（CLEAR UNIT・WTD）の効果を含み、後ろの WTD を含まない・保留（`holdWtd`／`heldFrom`）の前後で二重に組まれない・
  否定応答で打ち切るレコードの挙動は変わらない（READ SCREEN に達した時点の画面になるだけ）・`applyDataStream` のほかの呼び出し（`scripts/verify-gridlines-clear-unit.mjs`・`scripts/dump-screen.mjs`）は
  `buildReadScreen` を渡さず従来の枠（`record` 無し）になる
- (cross・委譲) [nit] READ SCREEN TO PRINT（0x66）の側の枠を積む case にテストが無い / 対応: 単体を 1 件足した（変異で検出）
- (cross・委譲) [nit] 1 レコードに READ SCREEN が 2 つあるとき、応答は最初の 1 本だけなのに 2 つ目も組んで捨てる / 対応: なし（ACS も READ SCREEN 系はレコードにつき 1 本。組み直しの負荷は 1,920 桁で無視できる）
- (cross・委譲) [nit] テストの固定待ち（30 ms）が遅い CI で不安定になりうる / 対応: なし（同じ書き方の既存の `read-screen-session.test.ts` と同じ。CI で実績がある）

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 3）。要件適合: AC1 は `read-screen-timing.test.ts`（3 件）、AC2 は `verify-read-screen-timing.mjs` pass=2（2 回。直す前は pass=1 fail=1）。
  価値適合: 応答の画面そのものを ACS のワイヤと同じ観測（OLD/NEW）で比べている。規約適合: 原則 2（測ってから直した）・測っていない EXTENDED・IMMEDIATE 系は変えず台帳に残した
