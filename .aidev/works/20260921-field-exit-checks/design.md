# 仕様: Field Exit・Field± の前の検査

## 設計方針
- `mandatoryCheck.ts` に純関数 `fieldExitRejection(field, edits, caretAtStart)` を置き、ACS の順（入力不可 → ME → MF）で理由を返す。
- `ScreenGrid.vue` の Field Exit・Field± の最初に通し（`rejectExit`）、止めるときは値を変えない。MF だけはカーソルを欄の先頭へ戻す。
- ME の Field Exit は AID のときの 0007 と別のエラー（0021）なので、文言の定数を分ける（`MSG_MANDATORY_ENTER_EXIT`。操作員エラー）。

## 依拠する既存の事実
- research F1〜F3。MDT は `mandatoryCheck.ts` の `mdtOf`（ホストの MDT か未送信の編集）。

## 受け入れ基準との対応
- AC1〜AC3: `packages/web-ui/test/field-exit-checks.test.ts`（純ロジック・ペインでの ME 3 例・入力不可・MF）
- AC4: mutation
