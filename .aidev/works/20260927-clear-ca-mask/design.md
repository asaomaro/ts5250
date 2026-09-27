# 仕様: CLEAR 系と CA キーの申告

## 設計方針
`clearUnitAlternate` と `clearFormatTable` で `aidNoDataMask = 0`。`clearFormatTable` は SOH の入口でも呼ばれるが、SOH はその直後に申告し直すので変わらない。

## 依拠する既存の事実
- SOH は `clearFormatTable` → `setHeaderData` の順（`wtd-applier.ts` の `case ORDER.SOH`）

## 受け入れ基準との対応
- AC1: `test/aid-data-mask.test.ts`（research F2）
- AC2: `scripts/verify-clear-ca-mask.mjs`
- AC3: DLTPGM と IFS の削除
