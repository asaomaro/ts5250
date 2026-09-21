# 設計

## 概要
- `ADDED_BY_VERSION[5]` に `ctrl+Home: view:ruleLine`・`ctrl+F11: view:cursorShape` を足す。`load` が版 4 以前の保存値へ追加分だけを混ぜる（使用中のキーは保存値が優先）。

## 対象範囲
- `packages/web-ui/src/stores/keybindings.ts`、`packages/web-ui/test/keybindings.test.ts`。

## 依拠する既存の事実
- `load` の版ごとの追加（`keybindings.ts`）。`view:` の割り当ては `makeKeydownHandler` が `viewCycle` へ渡す。

## インターフェース / データ構造
- 変更なし。

## 振る舞いの詳細
- Ctrl+Home は罫線の表示の順送り・Ctrl+F11 はカーソルの形の順送り（ACS の `[altcsr]` は 2 値の切り替え。当 PJ は選択肢の順送り）。

## エラー処理 / 異常系
- なし。

## 受け入れ基準との対応
- AC1〜AC2: `keybindings.test.ts` の 3 件。mutation 3 通り。
