# 調査: 半角の E 欄の末尾の空白

## 調査の問い
- Q1: E 欄（半角の状態・SI の無い E）と通常の SBCS の欄に打った末尾の空白を、ACS のコアはどう送るか

## 判明した事実
- F1（実機。`scripts/acs-probe/space-typed.txt` の f2・2026-10-01）: 半角の E に `A B` を打って Backspace（`A`＋空白）は READ MDT・ALT とも `c1 40`
- F2（実機。`space-typed-2.txt`・DSM の SPACETY2・2026-10-01）: compact の E（`SO あ SI`）の SI の桁に全角空白（`  い` を打って Backspace）は `0e 4481 4040 0f`。SO の次で Erase EOF（SI も消えて open）→ `い`＋Space＋`う` を打って Backspace は `0e 4482 0e 4040 0f`。通常の SBCS の欄に `A`＋空白は `c1 40`
- F3（`20260930-nul-typed-space`）: O 欄の同じ仕組みが実機で一致済み。core の送信は空のセルと空白のセルを見分ける
- F4（修正前の当 PJ）: 半角の E は `trimPad` が末尾の空白を落とし、`padDbcs` が空白で詰め、core の `setFieldCells` は末尾の空白を空のセルにしていた

## 影響範囲
- web-ui: `ScreenGrid.vue`（`trimPad`・`padDbcs`・`logicalFromCells`・`absorbDbcs`・`eitherDbcsOn`・End・貼り付けの詰め物）、`mandatoryCheck.ts`
- core: `buffer.ts` の `setFieldCells`・`setFieldValue`

## 実装アンカー
- A1: `ScreenGrid.vue` `trimPad`・`padDbcs`・新設 `eitherHalf`
- A2: `buffer.ts` `setFieldCells` の `chain`

## design への申し送り
- 半角の状態の E だけ（全角の状態・compact は詰め物が全角空白／半角空白のまま）
- open の E と通常の SBCS の欄は対象外（F2 の結果を台帳へ）
