# 仕様: 否定応答

## 設計方針
- `gds.ts` に `buildNegativeResponse(sense)`（ACS と同じヘッダ）。`ApplyResult.senseCode` を足し、`wtd-applier.ts` が F2 の 4 条件で立ててレコードの残りを読まない。
- ~~セッションは退避の応答の後に否定応答を送る~~ → 否定応答は**応答の最後**（WSF・READ SCREEN 系の応答の後。decisions D4）。データを読むかはオペコードで決める（`streamOf`）。未知のコマンドは 1 バイト読み飛ばして続ける。

## 依拠する既存の事実
- research F1〜F4。`ScreenBuffer.roll` は不正な指定で false を返す（`20260921-roll-vacated-rows`）。

## 受け入れ基準との対応
- AC1: `test/wtd-applier.test.ts`（4 条件のセンス・コード）・`test/alarm-and-query-size-session.test.ts`（否定応答のバイト列）
- AC2: `test/wtd-applier.test.ts`（未知のコマンドの後ろの WTD が届く）
- AC3: 実機（F3）・mutation
