# レビュー: HLLAPI の Tab・Backtab・Home で欄を出るときの MF・自己点検

## タスク点検ログ
（指摘なし）

## ラウンド 1（独立レビュー・サブエージェント）
- [should][conv:-] packages/server/src/hllapi-leave-check.ts:61 SO/SI のセルを「空白でない」と数えるので、全角のまま空にした E 欄（先頭 SO＋ヌル）が MF なら部分入力と誤判定する。J 欄は末尾の SI で途中まででも「満杯」になる / 対応: 字のセル（半角の非空白・全角）だけを中身とし、中身の直後の SI だけを使った桁に数える。E 欄を空にした・J 欄の途中まで・満杯の J 欄のテストを足す
- [should][conv:-] packages/server/src/hllapi-leave-check.ts:31 非表示欄は HLLAPI から書けるのにスナップショットに値が無く判定しない。コメントの「ペインと同じ」は不正確（ペインは編集中の値で判定できる） / 対応: コメントを直し、docs/HLLAPI.md に既知の差として書く。台帳にも残す
- [nit][conv:-] packages/server/src/hllapi-leave-check.ts:36 符号の桁を除くのは HLLAPI 側だけ（ペインは除かない） / 対応: ACS の原典どおりなので残し、差を注記して台帳へ
- [nit][conv:-] packages/server/src/hllapi.ts:748 継続欄の途中の区間で止まったときの戻り先 / 対応: ACS は `getField(元)`（区間の Field5250）の `getStartPos()`＝区間の先頭（原典）。コメントに書く
- [nit][conv:-] packages/server/test/hllapi.test.ts 自己点検のテストの題名が中身と合わない / 対応: 題名を直す

## ラウンド 2
- 前ラウンドの 5 件の解消を確認（DBCS の MF はセルの種類で判定し直してテスト 3 件・変異 7 通り検出、非表示欄と符号の桁の差はコメント・docs/HLLAPI.md・台帳に、継続欄の戻り先はコメント、テストの題名）。このラウンドの差分に must/should なし
