# 要件: CLEAR UNIT ALTERNATE・CLEAR FORMAT TABLE で SOH の CA キーの申告を捨てる

## 背景 / 課題
`.aidev/backlog/acs-parity.md` の【まとめ】DS5250 のその他の差の「CLEAR 系の付随処理」: 当 PJ は CU では CA マスクを捨てるが CUA・CFT では捨てない。**CUA で捨てない過去の判断は実測の裏が無く ACS 原典と逆**。

## 目的 / ゴール
CUA・CFT の後の F キーが欄データを送るかが ACS と同じになっている状態。

## ユーザーストーリー
- US1: 5250 端末の利用者として、画面を作り直された後の F キーで ACS と同じく欄データが送られてほしい。なぜなら前の画面の CA キーの申告が残ると、打った値が黙って捨てられるから。（受け入れ: AC1, AC2）

## スコープ
### 対象
- core `ScreenBuffer.clearUnitAlternate`・`clearFormatTable`
### 対象外
- ENPTUI 構造体の扱い（CFT で窓が残る・SOH で選択欄が二重）・画面サイズが変わったときの罫線（台帳に残す）。`msgLineRow` は `20260926-wec-msgline-row` で済み

## 完了条件 (受け入れ基準)
- [ ] AC1: 実機の ACS のコアで CUA・CFT・対照の 3 通りを測り、単体テストで固定する
- [ ] AC2: 実機で当 PJ を当てて同じ（`scripts/verify-clear-ca-mask.mjs`）
- [ ] AC3: 片付け
