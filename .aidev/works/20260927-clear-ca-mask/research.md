# 調査: CLEAR 系と CA キーの申告

## 判明した事実
- F1（原典）: `DS5250` の CU（`processClearUnit`）・CUA（同じく `processClearUnit`）・CFT（`case 80`）・SOH（`processClearFMT(true, false)`）はどれも `processClearFMT` を通り、`clearSOHPFKeyTable` で CA キーの申告を捨てる。
- F2（実測。2026-09-27・社内機・930。DSM の CACUA / CACFT / CANONE・`scripts/acs-probe/clear-ca-mask.txt`）: SOH（F3 を CA・5,10 に入力欄）→ CUA / CFT / 何もしない → 新しい入力欄（7,10。SOH なし）→ READ MDT。AB を打って F3。
  ACS のコア: CANONE `07 0c 33`（欄なし）、CACUA・CACFT `07 0c 33 11 07 0a c1 c2`（欄を送る）。当 PJ（直す前）: 3 つとも `07 0c 33`。
  2 回目（同じ日・プログラムを作り直して CACUA・CACFT）: 同じく `07 0c 33 11 07 0a c1 c2`。
- F4（当 PJ・直した後）: `scripts/verify-clear-ca-mask.mjs` pass=3 fail=0（CANONE `070c33`・CACUA / CACFT `070c3311070ac1c2`）。
- F3（当 PJ）: `buffer.ts` の `clearUnit` だけが `aidNoDataMask = 0`。コメントに「CUA では捨てない——SFLCTL の再描画のたびに来るので CA キーが CF キーに戻る」とあるが、実測の裏は無い（台帳）。
  SOH は `clearFormatTable` の後に `setHeaderData` で申告し直す（`wtd-applier.ts` の `case ORDER.SOH`）。

## 実装アンカー
- A1: `packages/tn5250/src/screen/buffer.ts` `clearUnitAlternate`・`clearFormatTable`
