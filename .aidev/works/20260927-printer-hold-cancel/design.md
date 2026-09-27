# 仕様: プリンターの応答を止めている間にホストが帳票を取り消したとき

## 概要
振る舞いは変えない（decisions D1）。実機で測った並びを単体テストで固定し、測定スクリプトを残す。白紙の件は backlog（D2）。

## 設計方針
research F1〜F3・F7 で当 PJ の振る舞いが ACS と同じで帳票も失われないと分かったため、固定と記録に留める。

## 対象範囲
- テスト: `packages/tn5250/test/printer-session.test.ts` の describe「respondAfter」に 1 件（止めている間に CLEAR・フラグ 0x18 の FF・CLEAR が来る並び）
- 測定: `scripts/verify-printer-hold-cancel.mjs`（新規。research の段で書いた）
- 台帳: deliver で消し込み、FF だけの帳票の要判断を足す

## 依拠する既存の事実
- 止めている間のレコードは溜め、解いた後に順に処理する（`packages/tn5250/src/session/printer-session.ts` の `onRecord` / `held`）
- ジョブの終わりはフラグ 1 がちょうど 0x08（`printer-session.ts` の `endOfJob`。ACS `DS5250P.processScs` と同じ）
- 試験の部品: `printer-session.test.ts` の `rec(flags, opcode, payload)`・`clearRecord()`・`endOfJob17()`・`replies()`・`openWith()`

## インターフェース / データ構造
- 変更なし

## 振る舞いの詳細
- 止めている間: データ → 終わり（止める）→ CLEAR → フラグ 0x18 の FF → CLEAR。解くと NO_ERROR・CLEAR_PROCESSED・NO_ERROR・CLEAR_PROCESSED。FF のジョブは `cleared: true` の帳票として閉じられる

## エラー処理 / 異常系
- 変更なし

## 受け入れ基準との対応
- AC1: research F1（実測。`verify-printer-hold-cancel.mjs`）
- AC2: research F2・F3・F6 と、単体テスト（上の並び）
- AC3: research F7（`HOLD_IDLE_MIN=17`）
- AC4: 測定スクリプトの片付け（残り: 無し）
