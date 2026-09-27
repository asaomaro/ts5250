# 仕様: ホストのエラーの間の WTD の保留

## 概要
core の `applyDataStream` に `holdWtd`、`Session5250` に溜めと `dismissHostError`、server に `dismiss-host-error`、web-ui の `exitErrorMode` から送る（decisions D1）。

## 設計方針
ACS の止め方（WTD の頭・後ろのレコードも並ぶ）をレコードの単位で写す。

## 対象範囲
- `packages/tn5250/src/protocol/wtd-applier.ts`: `applyDataStream` の `opts.holdWtd`・`ApplyResult.heldFrom`
- `packages/tn5250/src/session/session.ts`: `hostHeld`・`holdingForHostError`・`handleRecord(record, replay)`・`dismissHostError(seq?)`・`sendAid` の先頭・繋ぎ直しで捨てる
- `packages/server/src/ws-messages.ts`・`packages/server/src/ws-handler.ts`: `WsDismissHostError`・`onDismissHostError`
- `packages/web-ui/src/components/EmulatorPane.vue`: `exitErrorMode`
- テスト: `packages/tn5250/test/host-error-hold.test.ts`（新規）・`packages/web-ui/test/host-error-mode.test.ts`
- 実機: `scripts/verify-error-msgline-wtd.mjs`（判定を足す）

## 依拠する既存の事実
- research F2・F3

## インターフェース / データ構造
- `applyDataStream(data, buf, codec, warn, opts?: { holdWtd?: () => boolean })`・`ApplyResult.heldFrom?: number`
- `Session5250.dismissHostError(seq?: number): boolean`
- ws: `{ type: "dismiss-host-error", seq: number }`（クライアント → サーバー）

## 振る舞いの詳細
- WTD の頭で `systemMessage` があれば、そこから後ろを同じオペコードのレコードに組み直して溜めの先頭へ。溜めている間に届いたレコードは後ろへ
- 抜けると: メッセージと位置を外し、溜めを順に処理（途中で止まればそこまで）、画面を出す
- 予約中は画面の側の知らせを受けない（D2）

## エラー処理 / 異常系
- `seq` が数でなければ PROTOCOL_ERROR。3270・VT のセッションでは無視

## 受け入れ基準との対応
- AC1: `host-error-hold.test.ts`
- AC2: `host-error-mode.test.ts`
- AC3: `verify-error-msgline-wtd.mjs`（pass=4）
