# 調査: Field Exit 必須の欄（FER・RZ・RB・符号付き数値）

## 判明した事実
- F1（原典）: `Field5250.isFieldExitRequired` は `isFieldExitRequiredField`（FER）∨ `isRightAdjustBlankFillField`（RB）∨
  `isRightAdjustZeroFillField`（RZ）∨ `isSignedNumericField` を返す。`PS5250.processCharKeyStroke` は、Field Exit 必須の欄の
  最終桁まで打つと `setFieldExitReqFlag(true)` と `fieldExited = true` にして欄に留まる（自動送りしない）。
- F2（実機。`20260921-aid-without-field-exit` research F2）: RZ(A) を満杯（6 桁）まで打つとカーソルは欄の最終桁（3,25）に留まり、
  Enter は送れた（場合 10）。符号付き 6S0 の数字桁を満杯（5 桁）にすると符号桁（19,25）に留まり、Enter は 0020（場合 11）。
- F3（当 PJ）: 自動送りは FER ビットだけを見ていた（`ScreenGrid.vue` `advanceIfFull`・`dupKey`）ので、RZ/RB を満杯まで打つと次の欄へ
  送り、自動 Enter 欄なら Enter を送っていた。符号付き数値は数字桁を埋めても符号桁に留まり、自動送りは起きていなかった
  （Field Exit 必須の判定を FER ビットだけに戻す改変でも、符号付きの 0020 のテストは通った）。
