# 要件: その場で戻る否定応答の残り（READ の CC・引数の無い CLEAR UNIT ALTERNATE・SAVE PARTIAL の応答の順・警報の回数）を ACS と揃える

## 背景 / 課題
`.aidev/backlog/acs-parity.md` の「その場で戻る否定応答の残り」（`20260927-early-return-cc2`・`20260927-short-command-sense` から割った）。

## 目的 / ゴール
4 つの差が ACS の実測・原典で決着し、揃えられるものは揃っている状態。

## ユーザーストーリー
- US1: 5250 端末の利用者として、ホストの READ・CLEAR UNIT ALTERNATE・SAVE PARTIAL で ACS と同じ表示と応答になってほしい。なぜなら表示灯・画面・ホストの待ちが ACS と違うと業務の画面が変わるから。（受け入れ: AC1, AC2, AC3）

## スコープ
### 対象
- READ の CC1・CC2 を効かせるか
- 引数の無い CLEAR UNIT ALTERNATE（レコードの終わり）
- その場で戻る否定応答のレコードの SAVE PARTIAL の応答の順
- SAVE PARTIAL の前の警報が ACS では 2 回鳴ること
### 対象外
- READ の CC2 を先打ちの AID で効かせる（ACS `checkPendingAid`）——当 PJ の先打ちは画面の側

## 機能要件
- ACS と同じにする（下の完了条件）。警報の回数は合わせない（D1）

## 非機能要件 / 制約
- 実機で作った試験プログラム・ワイヤの記録は片付ける

## 完了条件 (受け入れ基準)
- [ ] AC1: 実機（DSM の READCC2 / CUANOPARM / SPROLL）で ACS のコアと当 PJ の画面・メッセージ待ち・応答の順が同じ
- [ ] AC2: 単体テストで固定する
- [ ] AC3: 片付け
