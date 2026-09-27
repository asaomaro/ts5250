# 仕様: SCS の SFSS

## 依拠する既存の事実
- 桁は整数の格子（`grid`）で持ち、全角は 2 桁（`putWide`）

## 受け入れ基準との対応
- AC1: `decode` の中に `widthScale`（1 か 2）を持ち、`put`・`putWide`・HT・TRN の空白の進みに掛ける。`skip2b` が SFSS を読んで `onSfss(横)` を呼ぶ
- AC2: 台帳の行を割る
