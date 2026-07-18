# レビュー記録

## ラウンド 1（2026-07-18T23:21:50Z）

自己レビュー（主エージェントが差分を直読）。
前段で指摘した項目の再発チェック——ピュア層での Node グローバル**なし**、
`Object.assign` による型外し**なし**、参照コメントあり。

- [should] `netprint-connection.ts` `readSpooledFileRaw` — **読み取り回数に上限が無い**。
  サーバーが `readEof` を返さず空でないデータを返し続けると無限ループになる。
  一覧側（`listSpooledFiles`）には `max` があるのに、こちらには歯止めが無い。
  / 対応: 修正済（累積バイト数の上限を設け、超えたら明示的に失敗させる）

- [should] `netprint-connection.ts` — スプールの CCSID を**既定 273 の決め打ち**にしている。
  PUB400 では正しいが、日本語環境（930/939/5035）では文字化けする。
  既存 `PrinterSession` は接続時に CCSID を受け取っており、**同じ SCS を扱うのに
  経路によって扱いが違う**のは一貫性を欠く。
  / 対応: 修正済（接続オプションで指定可能にし、既定値の根拠をコメントに明記）

- [nit] `spool-list.ts` `buildFilter` — OUTQ を指定しないとき、ライブラリ欄に空文字を入れている。
  実機では通るが、意図が読み取りにくい。
  / 対応: コメントを追加（値そのものは変えない）

- [nit] `netprint-datastream.ts` — 操作コードに `retrieveMessage` / `answerMessage` /
  `hold` / `release` 等を定義しているが**未実装**。定義だけ先にあるのは、
  MSGW 作業で使う意図を示すためだが、使われていない定数は誤解を招きうる。
  / 対応: 許容（コメントで「本作業では未実装」と明示済み）

- [nit] `readSpooledText` はページ区切りを失う。用途によっては不都合。
  / 対応: 許容（`readSpooledPages` を併せて公開しており、選べる）

must 0 件・should 2 件・nit 3 件。should はすべて修正した。
