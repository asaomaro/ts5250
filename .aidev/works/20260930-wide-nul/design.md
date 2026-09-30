# 仕様: 全角 1 桁の空き（WIDE_NUL）

## 概要
J・G・全角の E の値の詰め物を U+3164（`WIDE_NUL`。全角幅・入力に現れない）にし、打った全角空白（U+3000）は中身として残す。送る形は WIDE_NUL を NUL の組にする。

## 設計方針
O 欄・半角の E の空き（U+0000）と同じ考え方を、全角幅の欄へ。全角の字として数えられる専用の文字にして、桁・バイト長・列ビューの既存の計算をそのまま使う。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`・`composables/fieldValidate.ts`・`composables/mandatoryCheck.ts`

## 依拠する既存の事実
- U+3164 は全角幅（`isFullWidth`・`isCertainWideGlyph` とも真）で、入力に現れない（`@ts5250/base` の判定）
- 死んだ桁の印（生バイト 0x00）は core が空のセルに置く（`buffer.ts` の `setFieldCells`。J の空の組と同じ）
- J・全角の E の送る形は `jeExplicit`（`ScreenGrid.vue`）が作る

## インターフェース / データ構造
- `WIDE_NUL`（`fieldValidate.ts`）。`viewChar` は全角空白、`displayText` も全角空白
- `widenNul(v)`: 画面の値（edits）は WIDE_NUL を全角空白にして出す（G は詰めて送る）。送る形（wire）は正確に

## 振る舞いの詳細
- `padDbcs` の詰め物・貼り付けの空きは WIDE_NUL。`trimPad` は末尾の WIDE_NUL（と半角空白）だけを落とす
- `logicalFromCells`: J・G・全角の E の、書かなかった桁（生バイトの無い空白）2 つを WIDE_NUL 1 つにする
- `jeExplicit`: WIDE_NUL を DEAD_MARK の 2 つにする
- End・挿入の余地は WIDE_NUL も空きとして数える。必須埋めは WIDE_NUL があれば満杯でない

## エラー処理 / 異常系
- 変更なし

## 受け入れ基準との対応
- AC1: 実機 `verify-browser-space-typed.mjs`（12 の比較）
- AC2: `wide-nul.test.ts`
- AC3: `wide-nul.test.ts`（必須埋め）と既存の実機スクリプト
