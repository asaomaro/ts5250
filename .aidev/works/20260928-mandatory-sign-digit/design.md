# 仕様: 符号付き数値の欄の MF・自己点検で符号の桁を数えない

## 概要
`mandatoryCheck.ts` に「検査に使う値」を返す `checkedBody(f, value)` を置き、符号付き数値なら欄の長さまで空白で埋めてから最終桁を落とす。MF は長さ −1 で満杯を判定する。

## 設計方針
HLLAPI 側（`hllapi-leave-check.ts:44`・`:74`）と同じ規則。値は末尾の空白が落ちていることがある（編集の値）ので、先に欄の長さまで埋めてから落とす（そのまま最後の字を落とすと数字を落とす）。

## 対象範囲
- `packages/web-ui/src/composables/mandatoryCheck.ts`
- テスト `packages/web-ui/test/self-check-field.test.ts`・`packages/web-ui/test/ffw-behavior-bits.test.ts` 付近に追加（新規 `mandatory-sign-digit.test.ts`）

## 依拠する既存の事実
- ACS `Field5250.isFieldFull`・`isAllNulls`（符号付き数値は `endPos - 1` まで）・`checkModulusField`（長さ −1・検査桁は `endPos - 1`）——CFR のデコンパイル（scratchpad の `acs/out/.../Field5250.java:621`〜`:713`）
- HLLAPI は既に除く: `packages/server/src/hllapi-leave-check.ts:44`・`:74`
- 符号付き数値の欄は SBCS（数字のみ）で、符号の桁は `-` か空白（`fieldSign`）

## 受け入れ基準との対応
- AC1: `mandatoryFillViolated` が `checkedBody` と長さ −1 で判定する。入力は編集の値か `f.value`
- AC2: `selfCheckViolated` が `checkedBody` を `selfCheckDigitOk` へ渡す
- AC3: 符号付き数値でない欄は `checkedBody` が値をそのまま返す
