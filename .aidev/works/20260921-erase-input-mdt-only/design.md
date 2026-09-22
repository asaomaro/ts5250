# 仕様: Erase Input が、中身のある全入力欄を消す

## 概要
ACS `PS5250.processEraseInput` に合わせる。

## 設計方針
- 原典の事実に合わせる: clearNonbypassFields(true)（MDT の立った欄だけ）→ getHomePos()（IC で指した位置、無ければ既定）。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`

## 依拠する既存の事実
- ACS `PS5250.processEraseInput`（`javap -c -constants` で確認）。

## インターフェース / データ構造
変更なし（振る舞いのみ）。

## 振る舞いの詳細
clearNonbypassFields(true)（MDT の立った欄だけ）→ getHomePos()（IC で指した位置、無ければ既定）。

## エラー処理 / 異常系
変更なし。

## 要件との対応
- AC1: テストで固定。
- AC2: mutation で確認。
