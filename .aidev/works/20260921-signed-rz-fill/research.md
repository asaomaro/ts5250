# 調査

## 判明した事実
- F1: ACS `PS5250.performRightAdjustFill`（R11 の `key-edit-rest` (a)）: 埋め字は初期「調整しない」→ 符号付き数値なら空白・右端を符号桁の 1 つ手前 → **そのあとで** RB は空白・RZ は `'0'` に上書き。RZ の判定は FFW の下位 3 ビットが 5。
- F2: 実機の ACS のコア（既存の実測。`field-minus-numeric-only.txt`）: `CHECK(RZ) 6 0` に `12` → Field− は `000012-`。素の `6 0` に `34` → `    34-`。
- F3: 当 PJ は `applyAdjust` が `signedNumeric` を先に見て空白右寄せ。既存テスト「signed-num は ADJUST 指定より優先される」が固定していた（根拠は tn5250 / tn5250j で、ACS ではない）。

## 実装アンカー
- A1: `applyAdjust`（`packages/web-ui/src/composables/fieldEdit.ts`）。呼び出し元は `fieldExit`・`fieldSign`（`ScreenGrid.vue` の Field Exit・Field±）。
