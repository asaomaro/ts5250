# 決定記録

## D1: 死んだ桁は core のセルに `dead` を付けて持つ
- 背景: 台帳の (f) は「ホストが AID の後に画面を書き直すので観測できない」だった。実機の ACS のコア（解錠だけの WTD）で観測でき、E2 が D7 と一致した（死んだ桁が残る）
- 決定: 空のセル（null）とは別に、`dead: true` を付けた char セルにする。バイトとしては NUL（`cellAt`・`dbcsRawCell`・`allNul`）

## D2: 過去の決定の破棄
- 破棄: 台帳の「(f) 死んだ桁は、ホストが AID の後に画面を書き直すので実際には観測できない」（`20260930-cont-o-nul` の decisions・台帳の 2026-09-30 の記述）
- 証拠: `scripts/verify-browser-cont-o-dead-kept.mjs` E1・E2 が ACS と一致（修正前は死んだ桁が空きとして読み戻され、詰め直しの結果が変わる。単体 `o-chain-edit.test.ts` の変異で確認）
