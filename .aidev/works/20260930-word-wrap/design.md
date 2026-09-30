# 仕様: 語送りの欄

## 概要
core は語送りの欄に `wordWrap` の印と、途中の NUL を運ぶ値を持たせる。web-ui は編集モデルの空きの桁を NUL（U+0000）で持ち、打鍵・削除のあとに ACS の手順の移植（`wordWrap.ts`）を掛ける。

## 設計方針
NUL と空白の区別は**語送りの欄だけ**に持たせる（全欄に広げると値の表し方が全部変わる）。運ぶ道具は既にある `rawSentinel(0x00)`（O 欄の死んだ桁と同じ）。core は送信で NUL のセルを既に見分けるので、値の入口・出口だけ直す。

## 対象範囲
- core: `wtd-applier.ts`・`buffer.ts`（`InternalField.wordWrap`・`fieldValue`・`setFieldValue`・snapshot）・`types.ts`
- web-ui: `composables/wordWrap.ts`（新規・純関数）・`fieldEdit.ts`（`EditState.pad`）・`ScreenGrid.vue`

## 依拠する既存の事実
- FCW 0x8680 は `cont.wrap` として既に解釈され、組み合わせの不成立は `fieldAddFailure` が返す（`wtd-applier.ts:1393`）
- 送信は NUL のセルを見分ける（`read-response.ts:sendValue`）
- 編集モデルの `isBlank` は既に U+0000 を空きと数える（`fieldEdit.ts`）
- センチネルは 1 コード単位（U+DC00＋バイト。`attr-sentinel.ts`）なのでスライスの割りは崩れない

## インターフェース / データ構造
- `InternalField.wordWrap?` / `Field.wordWrap?`（立つときだけ）
- `fieldValue`（語送りの欄）: 途中の NUL を `rawSentinel(0x00)`、末尾の NUL・空白は落とす
- `setFieldValue`: SBCS の値の `rawSentinel(0x00)` は空きのセル
- `wordWrap(chars, at, cursor, rowEnds, cols)`: 結果 `{chars, cursor}` または `undefined`（収まらない）
- `EditState.pad?`: 消して詰めたあとの空きの字（語送りの欄は NUL）

## 振る舞いの詳細
- 印は「単独の欄で 1 行に収まらない」ときだけ（ACS は行に収まれば下ろす）
- 打鍵は欄の最終桁では掛けない（ACS は次の欄へ移るため）。Backspace・Delete・Delete Word のあとに掛ける。Erase EOF・Field Exit は掛けない
- 送信値: 末尾の NUL だけ落とし、打った空白は残す。表示は NUL も空白

## ドメイン固有の考慮
- ACS は「行末にちょうど収まる語」も送る（行末の桁が空白でなければ語の途中）。移植で保つ

## エラー処理 / 異常系
- 組み直しが欄に収まらなければ何も変えない（ACS と同じ）

## 受け入れ基準との対応
- AC1: `wordWrap.ts` の移植＋`word-wrap.test.ts`（W1〜W8 を打鍵の模擬で再現）
- AC2: `ScreenGrid.vue` の 4 か所のフックと `word-wrap-field-edit.test.ts`
- AC3: `buffer.ts` と `word-wrap-field.test.ts`
- AC4: `scripts/verify-browser-word-wrap.mjs`（実機）
