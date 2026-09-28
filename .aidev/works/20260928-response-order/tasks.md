# タスク: 応答をコマンドの順に送る

## 実装方針
applier に順の一覧 → session の送信を一覧の順に → オペコード 04 → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 否定応答・持ち越しの SAVE PARTIAL・早期 return の順を崩さない

## テスト方針
- 単体 `packages/tn5250/test/response-order.test.ts`・既存の tn5250 全件・実機のワイヤ

## タスク
- [x] T1: applier に `responses` を足し、各命令で積む
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `ApplyResult` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: session が `responses` の順に送る・オペコード 04 の退避だけ。単体テスト
      対象: `packages/tn5250/src/session/session.ts` 受信の処理・`streamOf` / 根拠: research A2
      依存: T1
      AC: AC1, AC2, AC4
- [x] T3: 実機のワイヤで当 PJ の順を確かめるスクリプト（実行は test 工程）
      対象: `scripts/verify-response-order.mjs`（新規）
      依存: T2
      AC: AC3
