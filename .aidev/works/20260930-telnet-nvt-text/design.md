# 仕様: 交渉の前のテキスト

## 概要
telnet 層が BINARY・EOR の交渉状態を持ち、どちらにも応じていない間の通常データを NVT のテキストとして `onNvtText` へ渡す。`nvt-text.ts` が ACS の書き出しを WTD にし、`Session5250` が通常のレコードと同じ道で画面へ流す。

## 設計方針
書き出しは純関数（`nvtTextToWtd`）。合成した WTD を既存の適用の道（`handleRecord`）へ渡すので、位置の検査・否定応答・カーソルは既存の ACS 一致の実装がそのまま効く。

## 対象範囲
- `telnet.ts`・`nvt-text.ts`（新規）・`session.ts`

## 依拠する既存の事実
- 起動応答は 1 レコード目だけを候補にする（`session.ts` の `firstRecord`）
- WTD の位置の検査・SBA 1,0 の扱いは ACS と一致済み（`wtd-applier.ts`。台帳の「WTD の中の否定応答」）
- 既存の試験は交渉を省いて IAC EOR 付きのレコードを流す（`read-screen-timing.test.ts` ほか）

## インターフェース / データ構造
- `TelnetLayer.onNvtText(fn: (text: Uint8Array) => void)`
- `nvtTextToWtd(input, cursor: {pos}, cols, rows): Uint8Array`
- `Session5250.nvt`（桁の位置。繋ぎ直しのたびに 0）

## 振る舞いの詳細
- 5250 のレコードの扱い: IAC EOR で終わる塊は交渉の前でもレコード（当 PJ の決め。バナーではありえない）
- テキストの後の 5250: 合成 WTD は最初のレコードの権利を使い切らない（`firstRecord` を戻す）
- 接続の待ち: テキストが出たら解く。キーボードは施錠のまま

## エラー処理 / 異常系
- 位置の検査に落ちる受信は捨て、否定応答を返す（ACS と同じ。既存の道）

## 受け入れ基準との対応
- AC1: `nvt-text.ts`・`nvt-text.test.ts`・`scripts/verify-nvt-text.mjs`
- AC2: `telnet.ts`・`nvt-text.test.ts`
- AC3: `session.ts`・`nvt-text.test.ts`
