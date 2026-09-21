# 調査

## 判明した事実
- F1: 原典（R11 の `key-edit-rest` (r)）: `processCharKeyStroke` の空白の変換（`convertSBCSCharToDBCS`）。
- F2: 実機の ACS のコア（社内機・930）: G・J は `あ　い`（空白は全角）・先頭の Space も全角空白。O は `あ` SO/SI の外に SBCS の空白。E は `X Y`（SBCS）・空の欄に Space→`X` は ` X`（SBCS）・`あ` の後の Space は全角空白で、その後の `X` は拒否（E は混ぜない）。
- F3: 当 PJ の `rejectReason`（`fieldValidate.ts`）は `only`・`pure` の半角 Space を `dbcs-required` で弾く。`either`・`open` は通す。

## 実装アンカー
- A1: `onDbcsKeydown` の文字の入口（`packages/web-ui/src/components/ScreenGrid.vue` の `const ch = inputChar(k, f)`）。
