# 調査

## 判明した事実
- F1: 原典（R11 の `key-edit-rest` (q)）: ACS は確定した字を 1 字ずつ打鍵として処理し、満杯なら次の入力欄へ移る。余りは次の欄へ入る。ACS の GUI 層の IME 確定は headless のコアでは測れない（未測定）。
- F2: 当 PJ の `onCompositionEnd`（`ScreenGrid.vue`）は、SBCS の上書きでは末尾で `typeChar` が同じ状態を返して黙って捨て、DBCS は `dbcsType` が undefined で `break` して余りを捨てた。満杯なら `advanceIfFull` が `field-full` を出す（ペインが次の欄へフォーカスを移す）。

## 実装アンカー
- A1: `onCompositionEnd`・`commitInto`・`flowToNextField`（`packages/web-ui/src/components/ScreenGrid.vue`）。
