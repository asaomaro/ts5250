# 仕様: 最後の残り

## 概要
(1) Erase で SI も中身も消えた E の送る形・欄の長さを ACS の組の作り方にする。(2) 通常の文字欄の値の詰め物を空き（NUL）にし、打った末尾の空白を送る。(3) 割れた全角の編集は ACS を測り、合わせない決定を残す。

## 設計方針
- (1) `jeErased`（Erase で中身が全部消えた open の E）だけに適用する。ホストが書いた open の E は従来どおり
- (2) 語送りの欄が持つ NUL の詰め物（`EditState.pad`・`wrapInputValue`・`wrapWire`）を、対象の欄に広げる。対象は DBCS でない・非表示でない・継続でない・数値でない欄
- (3) F3 は不正な DBCS を作る振る舞い。合わせない（decisions D1）

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`・`composables/fieldEdit.ts`、`packages/tn5250/src/screen/field-validate.ts`

## 依拠する既存の事実
- 語送りの欄の NUL の詰め物の仕組み（`ScreenGrid.vue` の `isWrapEdit`・`wrapInputValue`・`wrapWire`）
- core の通常の欄の値は U+0000 を空のセル、空白を非 NULL のセルにする（`buffer.ts` の `setFieldValue`）。送信は空のセルだけを NUL として落とす（`read-response.ts` の `sendValue`）
- Erase で open になる箇所は 2 か所（`eraseToEndDbcs`・Erase Input）

## インターフェース / データ構造
- `jeErased`（Set）、`openEBytes`、`usesNulPad`

## 振る舞いの詳細
- open の E（Erase 後）: 中身 n 字は n=0 で 1・n=1 で 3・n≥2 で 2n+3 バイト。送る形は 2 字以上で `SO 先頭 SO 残り SI`
- 通常の欄: 詰め物は NUL。末尾の NUL だけ落とし、打った空白は残す。選択の削除の詰め物・End・型の検証も NUL を空きとして扱う

## エラー処理 / 異常系
- 変更なし

## 受け入れ基準との対応
- AC1: 実機 `verify-browser-open-e.mjs`（12）・`open-e.test.ts`
- AC2: 実機 `verify-browser-sbcs-space.mjs`（6）・`o-field-nul.test.ts`・既存の実機スクリプト
- AC3: `cont-o-split-edit.txt` の測定と decisions D1
