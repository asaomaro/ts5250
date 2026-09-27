# 仕様: その場で戻る否定応答の残り

## 概要
READ は CC を読み飛ばす、引数の無い CLEAR UNIT ALTERNATE は 0 として消す、その場で戻ったレコードの SAVE PARTIAL の応答は次のレコードの `sendNegative` の頭で送る。

## 設計方針
原典（research F1〜F3）と実測（F5）に合わせる。警報の回数は D1。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`（READ・CLEAR UNIT ALTERNATE・`ApplyResult.earlyReturn`）
- `packages/tn5250/src/session/session.ts`（`carriedSavePartial`）
- テスト: `packages/tn5250/test/early-return-rest.test.ts`（新規）
- 実機: `scripts/host-src/dscmd.c`・`scripts/acs-probe/early-return-rest.txt`・`scripts/verify-early-return-rest.mjs`・`scripts/README.md`

## 依拠する既存の事実
- 否定応答は `sendNegative` で最後に送る（`session.ts`）。退避の応答はその前に送る

## インターフェース / データ構造
- `ApplyResult.earlyReturn?: boolean`

## 振る舞いの詳細
- 持ち越した SAVE PARTIAL の応答は、次のレコードがその場で戻らなければそのレコードの否定応答の前に送る。繋ぎ直しで捨てる

## エラー処理 / 異常系
- なし

## 受け入れ基準との対応
- AC1: research F5・F6
- AC2: `early-return-rest.test.ts`
- AC3: 片付け
