# 調査

## 判明した事実
- F1: 原典（R11 の `key-edit-rest` (p)。`PS5250.reserveRoomForInsert`）: 欄の最終桁にカーソルなら即エラー。そうでなければ末尾からカーソルまで NUL・半角空白・全角空白が続く桁数を数え、SO/SI の桁で止まる。J・E は末尾の SI の 1 桁手前から数える。
- F2: 実機の ACS のコア（社内機・930。dump は `scratchpad/dbcs-insert.out` と F の `dbcs-insert-f.out`）: A1・A2・A3 成功、B1（J の SI の桁）・B2（O の最終のセル）は inhibit=5、B3 成功、C1 成功・C2 0012、G1 成功、F1（O の末尾が全角空白）0012、E も J と同じ。C3・C4（O の中の SO/SI を含む必要桁）は 0012。
- F3: 当 PJ の DBCS の挿入は `dbcsType`（`ScreenGrid.vue`）が予算超過を `absorbDbcs` で末尾の半角空白だけ削って吸収し、削り切れなければ拒否＋0012。
- F4: 貼り付けの事前の検査 `insertInto` は欄全体の余地だけを見る（末尾の空白類 `\s+$`＝U+3000 も含めて空きに数える）。

## 実装アンカー
- A1: `absorbDbcs`・`dbcsType`（`packages/web-ui/src/components/ScreenGrid.vue`）。
- A2: 呼び出し 4 か所（打鍵・貼り付け・IME の確定。`dbcsType(` を grep）。
