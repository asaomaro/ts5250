# 要件: Erase Input が、中身のある全入力欄を消す

## 背景 / 課題
台帳 `acs-parity.md` の項目。ACS `PS5250.processEraseInput` を `javap -c -constants` で原典確認: clearNonbypassFields(true)（MDT の立った欄だけ）→ getHomePos()（IC で指した位置、無ければ既定）。

## 目的 / ゴール
- ACS と同じ振る舞いになっている状態。

## ユーザーストーリー
- US1: 端末の利用者として ACS と同じ操作感がほしい。なぜなら ACS の癖で操作して意図しない結果になるのを避けたいから。（受け入れ: AC1）

## スコープ
### 対象
- `packages/web-ui/src/components/ScreenGrid.vue`
### 対象外
- 台帳に書かれた付随の差。

## 機能要件
- FR1: ACS と同じ振る舞いにする。

## 非機能要件 / 制約
- 原典の事実だけを持ち帰る（逐語移植しない）。

## 完了条件 (受け入れ基準)
- [ ] AC1: ACS と同じ振る舞いがテストで固定されている。
- [ ] AC2: 実装を戻すとテストが落ちる（`verify-by-mutation`）。
