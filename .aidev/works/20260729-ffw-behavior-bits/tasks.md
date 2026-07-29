# タスク: FFW の挙動ビットに従う

- [x] T1: `types.ts` に任意フラグ 6 つを足し、`digitsOnly` の JSDoc の誤記（0x0600 → 0x0500）を直す
- [x] T2: `buffer.ts` の snapshot 組み立てで FFW のビットを写す（依存: T1）**関門**
- [x] T3: core `field-validate.ts` に alpha-only を足す（依存: T1）
- [x] T4: web-ui `fieldValidate.ts` の `rejectReason` に `alpha-only` / `kbd-inhibited`（依存: T1）
- [x] T5: core テスト `field-ffw-bits.test.ts`（依存: T2, T3）
- [x] T6: `opMessages.ts` に操作員メッセージ 4 件（依存: T4）
- [x] T7: `ScreenGrid.vue` — `inputChar(ch, f)` / FER / AUTO_ENTER（依存: T1, T6）
- [x] T8: `EmulatorPane.vue` — Enter 前の必須検証（依存: T7）
- [x] T9: web-ui テスト（依存: T7, T8）
- [x] T10: 空振り検証（依存: T5, T9）
- [x] T11: ビルド（`vue-tsc` 込み）・全テスト（依存: 全部）
