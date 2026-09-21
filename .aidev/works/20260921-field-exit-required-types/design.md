# 仕様: Field Exit 必須の欄を ACS と同じく扱う

## 概要
`isFieldExitRequired(f)`（FER ∨ RZ ∨ RB ∨ 符号付き数値。ACS と同じ）で自動送りと Dup の後の送りを止め、
キャレットが欄の右端の境界へ出たら 0020 の待ちを外す（ACS の `fieldExited` と、欄の外へ出た場合に当たる）。

## 対象範囲
- `packages/web-ui/src/composables/mandatoryCheck.ts`（`isFieldExitRequired`）
- `packages/web-ui/src/components/ScreenGrid.vue`（`advanceIfFull`・`dupKey`）
- `packages/web-ui/src/components/EmulatorPane.vue`（0020 の待ちの監視）

## 依拠する既存の事実
- 原典と実機: research F1・F2。当 PJ: F3。
- 0020 の待ち: `20260921-aid-without-field-exit`（`awaitingFieldExit`）。右端の境界: `fieldAtCaret`（`20260921-mandatory-check-acs`）。

## 受け入れ基準との対応
- AC1: `isFieldExitRequired` を `advanceIfFull`・`dupKey` で使う。
- AC2: 0020 の待ちの監視で、右端の境界（`fieldAt` では欄の外）なら外す。
- AC3: `ffw-behavior-bits.test.ts`（3 件）・`aid-field-exit-required.test.ts`（2 件）と mutation。
