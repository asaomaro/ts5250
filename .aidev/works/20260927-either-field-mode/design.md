# 仕様: E 欄の半角・全角

## 概要
`eitherModeSwitch` を足し、DBCS の打鍵と IME の確定で使う（D1）。

## 設計方針
原典と実測（research F1・F2）に合わせる。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`（`eitherModeSwitch`・DBCS の打鍵・`commitInto`）
- `packages/web-ui/src/composables/opMessages.ts`（0060・0061 の文言と `isOperatorError`）
- テスト: `packages/web-ui/test/either-field-mode.test.ts`（新規）
- 実機: `scripts/acs-probe/either-field-mode.txt`

## 依拠する既存の事実
- E 欄の値は論理値（SO/SI なし）。打鍵は `dbcsType`（`ScreenGrid.vue`）

## インターフェース / データ構造
- なし

## 振る舞いの詳細
- research F1 のとおり（先頭での切り替えは欄を空にする）

## エラー処理 / 異常系
- 0060・0061 は操作員エラー（エラー状態に入る）

## 受け入れ基準との対応
- AC1: research F2 と `either-field-mode.test.ts`
- AC2: 同
- AC3: 片付け
