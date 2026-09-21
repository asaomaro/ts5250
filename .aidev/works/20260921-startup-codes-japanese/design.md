# 仕様: 起動応答で断られた理由を日本語で出す

## 設計方針
- web-ui の `opMessages.ts` に失敗のコードの日本語の意味（`STARTUP_CODE_MEANING_JA`。意味は ACS の文言表と RFC 4777 に基づき、文言は当 PJ で書く）と、
  サーバーの文言からコードと装置名を拾う `startupRejectionText` を置く。`wsErrorNotice` と、開く前の失敗の `openErrorText` がこれを使う。
- 構造化した項目をワイヤに足さず、サーバーの文言（当 PJ が作る決まった形）から拾う——文言の形は `session.ts`・`printer-session.ts` の 3 か所。
- 英語の表（`startup-record.ts`）の 2703・2777・8936 を ACS の意味に直し、プリンター側の重複した 8936 を外す。
- 失敗のコードの一覧は tn5250 と web-ui のテストが同じ並びで固定する（パッケージをまたいで import しない）。

## 依拠する既存の事実
- research F1〜F4。

## 受け入れ基準との対応
- AC1: `packages/web-ui/test/startup-rejection-ja.test.ts`（形・プリンター・答え直しの文言・表に無いコード・通知と開く前の出し分け・`openSession` / `openPrinterSession` の reject）
- AC2: `packages/tn5250/test/startup-record.test.ts`（意味と一覧）・`startup-rejection-ja.test.ts`（同じ一覧）
- AC3: mutation
