# レビュー: 挿入モードの余地

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。
- 自己点検で見たこと: 余地の判定は純関数 1 つに集まっているか（打鍵・IME・継続欄・`typeChar` がすべて `insertChar` を通る）、
  選択の置換は従来の経路のまま、型の検査が余地より先（ACS `checkSBCSField` → `reserveRoomForInsert`）、エラーは `isOperatorError` に入る定数。

## ラウンド 2（節目の独立点検・5 件をまとめて。差し戻し）
- 別コンテキストに 5 コミット（e100b573・6c702521・51abff32・2708da79・194c6e18）の相互作用を読ませた。自作の再現テストで裏を取った指摘だけ。
- [nit][conv:-] `ScreenGrid.vue` `onCompositionEnd` — 選択を置き換える IME 確定を挿入モードで行うと `typeChar` を通り、余地が無いと残りの字が通知なしに消えた（`lastTypeable` も符号桁を見ない）/ 対応: 挿入モードなら選択の置換でも `insertChar`。テスト 1 件

## ラウンド 3（通過）
- 修正を外す mutation（V-7）で検出。
