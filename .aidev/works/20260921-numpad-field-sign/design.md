# 仕様: テンキーの ± と Field−

## 設計方針
- `classifyKey` に `code` を足し、修飾なしの `NumpadSubtract` / `NumpadAdd` を `local: field-minus / field-plus` にする（ACS `B109` / `B107`）。
- ScreenGrid の印字文字の枝（SBCS・DBCS）は、テンキーの ± なら何もせず戻す（ペインのキーマップが拾い、既定動作もそこで止める）。
- `fieldSignKey(negative)`: Field− で、符号付き数値でも数値専用（`numeric && !digitsOnly && !signedNumeric`）でもない欄か継続欄なら、
  `MSG_FIELD_MINUS_INVALID`（0022。`isOperatorError` に入れる）を出して何もしない。
- `rejectReason`: 符号付き数値は数字だけ（`numeric`）。`signKeyHack` は撤去（取り消し線のコメントで経緯を残す）。

## 依拠する既存の事実
- ペインの `onLocal("field-minus")` → `ScreenGrid.fieldMinus()`（`EmulatorPane.vue`）。キーマップは対象のキーで `preventDefault` する（`makeKeydownHandler`）。
- Ctrl+− / Ctrl++ の既定の割り当て（`keybindings.ts` の版 3）はテンキーの無い機械向けに残る。

## 受け入れ基準との対応
- AC1: `numpad-field-sign.test.ts`。AC2: `field-sign-dup.test.ts`・`numpad-field-sign.test.ts`。AC3: `field-keystroke-rules.test.ts`。AC4: mutation。
