# 仕様: 触らない桁の目印

## 概要
中身が入って届く非表示の DBCS 欄で、中身のある桁を「触らない桁の目印」として値に持ち、保存（`setField`）のとき core が元の中身へ戻す。

## 設計方針
中身（字・バイト）は core から出さず、桁の番号だけを運ぶ。編集エンジンは目印を通常の字（半角 1 桁・全角 2 桁）として扱うので、上書き・挿入・Delete・Backspace・Erase EOF が ACS の表どおりに動く。

## 対象範囲
- `packages/tn5250/src/screen/{attr-sentinel,buffer,types}.ts`・`session/session.ts`・`browser.ts`、`packages/web-ui/src/components/ScreenGrid.vue`

## 依拠する既存の事実
- 非表示のセルは字を空白にして出す（`buffer.ts` の `snapshot`。平文が外に出ない不変条件）
- 保存の入口は `Session5250.setField`（`session.ts`）。ws・MCP・マクロが通る
- 編集エンジンの全角判定は `isWideForDbcs`（BMP の私用領域は全角幅）

## インターフェース / データ構造
- `keepNarrow(idx)`（第 15 面）・`keepWide(idx)`（BMP 私用領域の末尾。全角幅）・`keepIndex(ch)`（`attr-sentinel.ts`）
- `Cell.keep`（非表示の欄の中身のある桁）
- `ScreenBuffer.mergeKeep(field, value)`

## 振る舞いの詳細
- web-ui は非表示かつ DBCS 申告の欄で、`keep` の桁を目印にして値を作る
- `setField` は検証の前に `mergeKeep` する。目印が欄の外・空きを指せば空白（全角は全角空白）。非表示でない欄の値は変えない

## エラー処理 / 異常系
- 目印が不正な桁を指してもエラーにしない（空白にする）

## 受け入れ基準との対応
- AC1: 実機 `verify-browser-hidden-dbcs.mjs`（6 の比較）・`hidden-keep.test.ts`・`wide-nul.test.ts`
- AC2: `hidden-keep.test.ts`（snapshot の字は空白のまま）
