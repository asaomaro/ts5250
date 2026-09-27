# 仕様: 長さの足りないコマンドの否定応答

## 概要
`applyDataStream` に `tooShort` を足し、WTD・READ・ROLL・WRITE ERROR CODE の入口で長さを検査する（decisions D1）。

## 設計方針
ACS の長さの検査（research F1）をそのまま写す。戻り方は既存の `abortRecord`（CC2 を落とす）。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`（`tooShort` と 4 つの入口）
- テスト: `packages/tn5250/test/early-return-cc2.test.ts`（describe「長さの足りないコマンド」）・`packages/tn5250/test/window-error-code.test.ts`（0x22 の 0 バイト）
- 実機: `scripts/host-src/dscmd.c` の SHORT*・`scripts/acs-probe/short-command-sense.txt`・`scripts/verify-short-command-sense.mjs`

## 依拠する既存の事実
- `abortRecord`（`wtd-applier.ts`。`20260927-early-return-cc2`）: 否定応答を立て、CC2 の警報・メッセージ待ちを SAVE PARTIAL の時点まで戻す
- 否定応答はセッションが送る（`senseCode`。`packages/tn5250/src/session/session.ts`）

## インターフェース / データ構造
- 変更なし

## 振る舞いの詳細
- WTD / READ: 残りが 2 バイト未満 → 0x10050121。ROLL: 3 バイト未満。WRITE ERROR CODE 0x21 / 0x22: 0 バイト。足りていれば従来どおり

## エラー処理 / 異常系
- 以前の読み過ぎの例外（レコードごと捨てる）はこの 4 つでは起きなくなる

## 受け入れ基準との対応
- AC1: research F2・F3（`verify-short-command-sense.mjs` pass=12、ACS のコアの 4 通り）
- AC2: `early-return-cc2.test.ts` の 6 形＋対照、`window-error-code.test.ts`
- AC3: DLTPGM（CPC2191・CHKOBJ で CPF9801）と IFS の削除
