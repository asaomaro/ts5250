# 仕様: 半角の状態の E 欄の空き（NUL）と空白

## 概要
O 欄と同じ「値の U+0000＝空き・U+0020＝空白（中身）」を、半角の状態の E 欄へ広げる。

## 設計方針
`eitherHalf(f, chars)`（E で、値が全角の状態でない）を 1 つ作り、O 欄の分岐と同じ場所で使う。全角の状態の E は変えない。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`・`composables/mandatoryCheck.ts`
- `packages/tn5250/src/screen/buffer.ts`
- テスト・実機検証スクリプト・台帳

## 依拠する既存の事実
- E の状態（全角か半角か）は値の字か、この画面で切り替えた状態（`eitherSwitched`）か、core の `Field.eitherDbcsOn` で決まる（`ScreenGrid.vue` の `eitherDbcsOn`）
- O 欄の同じ仕組みは実機で一致済み（`20260930-nul-typed-space`）
- 送信は空のセルと空白のセルを見分ける（`read-response.ts` の `sendValue`）

## インターフェース / データ構造
- `eitherHalf(f, chars?)`
- core: `setFieldCells`・`setFieldValue` は E の空白を生バイト 0x40 のセルにする（末尾も落とさない）

## 振る舞いの詳細
- 半角の E: 詰め物は U+0000、末尾の U+0000 だけを落とす。End は空きを飛ばす。挿入は末尾の空きを押し出す（`absorbDbcs`）。空きのある値は必須埋めで満杯でない
- 全角の状態の E・J・G・O 以外は変更なし

## エラー処理 / 異常系
- 変更なし

## 受け入れ基準との対応
- AC1: `o-field-nul.test.ts`（E の節）・`o-field-send.test.ts`・実機 `verify-browser-space-typed.mjs` の f2
- AC2: `o-field-nul.test.ts`
- AC3: 実機の既存スクリプト
