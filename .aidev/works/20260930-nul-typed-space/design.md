# 仕様: 継続でない O 欄の空き（NUL）と空白

## 概要
継続した O 欄の鎖（`20260930-cont-o-nul`）が持つ「値の U+0000＝空き・U+0020＝空白（中身）」を、継続でない O 欄にも広げる。

## 設計方針
鎖の仕組みをそのまま使う（新しい表し方を作らない）。値の文字列・`OCell.nul`・core の U+0000→空のセル・空白→生バイト 0x40 のセルがすでにあるので、継続の鎖に限っていた条件（`isOChain`・`field.continued !== undefined`）を O 欄全体（`isOCells`・`dbcsType === "open"`）へ緩める。J・E は詰め物が全角空白（打った全角空白と区別できない）なので別の work。

## 対象範囲
- web-ui: `ScreenGrid.vue`・`oFieldCells.ts`・`mandatoryCheck.ts`
- core: `buffer.ts`
- テスト・実機検証スクリプト・台帳

## 依拠する既存の事実
- 鎖は値の U+0000 を空きとして持つ（`oFieldCells.ts` の `OCell.nul`・`toCells`。`20260930-cont-o-nul` の実機 C01〜C12・P1〜P8 で一致済み）
- 送信は空のセルと空白のセルを見分ける（`read-response.ts` の `sendValue`・`rawDbcsSendValue`。`20260927-read-alt-raw` の実機で一致済み）
- O 欄の操作は `oFieldCells.ts` の表で行い、`freeCells` は空きも空白も余地に数える（ACS `reserveRoomForInsert`。同ファイル `freeCells`）

## インターフェース / データ構造
- `toCells(chars, length)`（詰め物は常に空き。`padNul` 引数は廃止）
- `trimPad`（O 欄は末尾の U+0000 だけを落とす）・`padDbcs`（O 欄の詰め物は U+0000）・`logicalFromCells`（O 欄の生バイトの無い空白は U+0000）
- core: `setFieldCells`・`setFieldValue` は O 欄の空白を生バイト 0x40 のセルにし、末尾の空白も落とさない

## 振る舞いの詳細
- 打った空白・ホストが書いた空白は中身（末尾でも送る）、空きは末尾なら送らず、途中は READ MDT で 0x40・ALT で 0x00
- End は 0x40 も空きも飛ばす（ACS `getEndPosition`）。入力欄の表示は空きを空白にする
- 必須埋め: O 欄に空きが 1 桁でもあれば満杯でない。打った空白は埋まっている

## エラー処理 / 異常系
- 変更なし（0005・0012・0065 の判定は表のまま）

## 受け入れ基準との対応
- AC1: `o-field-nul.test.ts`・`packages/tn5250/test/o-field-send.test.ts`・実機 `verify-browser-space-typed.mjs`（f3・f4）
- AC2: `o-field-nul.test.ts`
- AC3: `o-field-nul.test.ts`（必須埋め）
- AC4: 実機の既存スクリプト（o-field・cont-o・cont-o-paste・cont-o-lone-shift・je-field・either-remainder・either-empty-view）
