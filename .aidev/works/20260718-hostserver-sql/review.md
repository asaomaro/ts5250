# レビュー記録

## ラウンド 1（2026-07-18T15:58:43Z）

自己レビュー（主エージェントが差分を直読）。

まず前段（signon）で指摘した 2 件の再発を機械的に確認した——
ピュア層での Node グローバル（`Buffer` 等）**なし**、`Object.assign` による型外しの後付け**なし**。
参照コメントは 9 ファイルすべてに存在し、純 DBCS のみ本体 JTOpen を指す書き分けもできている。

- [should] `db/query.ts:123-129` — `query()` が **例外時にカーソルを閉じない**。
  `stream()` は try/finally で閉じているのに `query()` は素通りで、
  行の復号中にエラーが出るとサーバー側のカーソルが開いたまま残る。
  同じ責務の 2 関数で後始末の扱いが違うのは事故のもと。
  / 対応: 修正済（try/finally に統一）

- [should] `db/query.ts` — **文名・カーソル名がモジュール定数**（`"S1"` / `"C1"`）で、
  1 つの接続で問い合わせを重ねると衝突する。とくに `stream()` は行の合間に制御を返すため、
  消費側が反復の途中で別の `query()` を呼べてしまい、**同じカーソルを踏み合う**。
  transport は「要求が飛行中」を弾くが、await の合間は素通りする。
  / 対応: 修正済（接続に「実行中」フラグを持たせ、重複実行を明示的に拒否）

- [nit] `db/query.ts:100` — `checkSqlca` の引数型が
  `ReturnType<DbConnection["request"]> extends Promise<infer R> ? R : never` と迂遠。
  `Reply` を直接書けばよい。
  / 対応: 修正済

- [nit] `db/db-reply.ts` — `parseDataFormat` の列長を `getUint16` で読んでいる。
  対象外の型（LOB 等）では 65535 を超えうるが、それらは `isSupportedType` で弾くため実害なし。
  / 対応: 許容（対象外の型に到達しない）

- [nit] `db/db-connection.ts` — **フレームをトレースしない**。signon には
  `traceFrame`（パスワードのマスク付き）を入れたが database 側には無い。
  資格情報の漏洩リスクは無い（そもそも出力しない）が、障害時の診断手段が無く、
  実際この工程では使い捨てスクリプトを何度も書く羽目になった。
  / 対応: 許容（本作業では入れない。test-result.md の未検証範囲に記載し deliver へ引き継ぐ）

must 0 件・should 2 件・nit 3 件。should はすべて修正した。
