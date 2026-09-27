# レビュー: E 欄の半角・全角

## タスク点検ログ
- [must][conv:-] T1 `ScreenGrid.vue` 全角の状態を「値の先頭の字」で近似していた（ACS は欄ごとの持続する状態。消しても全角のまま）/ 対応: コアに `eitherDbcsOn` を持たせた（decisions D4・T3）
- [should][conv:-] T1 `ScreenGrid.vue` 選択を消した後に拒否すると、モデルからだけ選択が消える / 対応: 打鍵は消す前へ戻し、IME は 1 字目の拒否で戻す（D5）
- [should][conv:-] T1 `ScreenGrid.vue` 「全角の状態」の判定が `spaceToFullWidth` と 2 通り / 対応: `eitherDbcsOn` 1 つにした
- [nit][conv:-] T1 カーソルの意味・挿入・IME の打ち切りは ACS と合っている（指摘のみ）/ 対応: なし
- [nit][conv:-] T1 伏せ字の E 欄と Dup は規則の外 / 対応: 台帳の残りに書く
- [should][conv:measurement-sanity!] T2 実測 B のテストが無かった / 対応: 足した
- [should][conv:verify-by-mutation!] T2 IME・選択・消去後・Space のテストと変異の記録が無い / 対応: 足し、変異 5 件（web-ui）と 4 件（コア）がすべて落ちることを確かめた
- [should][conv:measurement-sanity!] T2 「先頭で全角へ切り替え」「消去後の状態」を実機で測っていない / 対応: 測った（research F4）
- [nit][conv:-] T2 施錠に入ることは単体で見ていない / 対応: `isOperatorError` に足したのは定数の登録だけで、施錠の配線は既存のテストが見ている（そのまま）

## 横断点検（cross）
- [nit][conv:-] decisions D1 の事実（ACS は先頭の SO で見る）が原典と合わない / 対応: 取り消し線にして D4 で破棄
- [nit][conv:-] D2（貼り付けは対象外）の残りが台帳に無い / 対応: 台帳に兄弟の `[ ]` として割る

## ラウンド 1（全体レビュー・委譲）
- [must][conv:-] `packages/tn5250/src/screen/buffer.ts` `addField` 同じ位置の欄を SF で定義し直すと全角の状態が消える（ACS `FFT5250.addFieldToFFT` は同じ位置の欄を使い回して `EitherFieldDBCSOn` を残す。消えるのは CLEAR UNIT）。テストも逆を固定していた / 対応: 同じ位置の E 欄の状態を引き継ぐ（decisions D6）。テストを逆にし、CLEAR UNIT で消えることを足した
- [should][conv:-] `packages/tn5250/src/screen/buffer.ts` スナップショット `eitherDbcsOn` の行を `dbcsType` と `dbcsContent` の else-if の間に挟み、申告のある DBCS 欄にも `dbcsContent` が付いた / 対応: 連鎖の外（後ろ）へ移し、J 欄で `dbcsContent` が付かないテストを足した（挟み直す変異で落ちることを確かめた）

## ラウンド 2
- 前ラウンドの 2 件は解消（`either-dbcs-flag.test.ts` 9 件・変異 2 件とも落ちる）
- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue` `rejectExit` の「E 欄の先頭に SO があるか」が列ビュー（中身が全角で始まるか）で決まる 3 つ目の定義のまま / 対応: `eitherDbcsOn` にした（ACS は全角の状態なら空でも SO が先頭）。自分で見つけてその場で直した
- このラウンドの差分に残る must/should なし（web-ui 2822 件・tn5250 1030 件が緑）
