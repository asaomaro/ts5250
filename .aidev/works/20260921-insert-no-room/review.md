# レビュー: 挿入モードの余地

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。
- 自己点検で見たこと: 余地の判定は純関数 1 つに集まっているか（打鍵・IME・継続欄・`typeChar` がすべて `insertChar` を通る）、
  選択の置換は従来の経路のまま、型の検査が余地より先（ACS `checkSBCSField` → `reserveRoomForInsert`）、エラーは `isOperatorError` に入る定数。
