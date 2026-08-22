# 作業

- [x] 比較スクリプトを書く（`scripts/compare-hosts-osaka-pub400.mjs`）
- [x] 両機で走らせて差分表を採る
- [x] `QSNDDTAQ` の長さ引数を直す（**PACKED(5,0)**。2 進で渡して `CPF24B4` だった）
- [x] `QCDRCMDD` が「no data」になる理由を実機のメッセージまで降りて確かめる
- [x] **握り潰していたホストのメッセージを返すよう直す**（`command-template.ts`）
- [x] CPF → エラーコードの写しを共有に出す（3 つ目の複製を作らない。`cpf-errors.ts`）
- [x] 当方が使う SQL サービスが**両版に在ることを確かめる**
- [x] 単体テストを足す（`command-template.test.ts`）
- [x] backlog を閉じる
