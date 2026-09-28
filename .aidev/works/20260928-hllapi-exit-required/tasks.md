# タスク: HLLAPI のエラー 0x20

## 実装方針
接続の状態 → 打鍵・移動 → AID の前の検査 → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 画面が変わっても `unexited` の欄の番号が残る——送ったら下ろす（ホストが書き直す）

## テスト方針
- 単体 `packages/server/test/hllapi.test.ts`・実機

## タスク
- [x] T1: `Connection.unexited` と打鍵・移動・送信での上げ下げ、`aidCheck` の 0x20 と順
      対象: `packages/server/src/hllapi.ts` `sendKey`・`aidCheck`・`sendAid` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: 実機の検証（実行は test 工程）
      対象: `scripts/verify-hllapi-exit-required.mjs`（新規）
      依存: T1
      AC: AC3
