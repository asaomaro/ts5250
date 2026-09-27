# タスク: その場で戻る否定応答と CC2

## 実装方針
`abortRecord` を足し、テストと実機の検証を足す。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 否定応答の既存テスト（`negative-response-order.test.ts`）が変わらないこと。

## テスト方針
- `early-return-cc2.test.ts`・`negative-response-order.test.ts` と tn5250 全体。変異: 2 行（alarm・messageWaiting）それぞれ。

## タスク
- [x] T1: `abortRecord` で否定応答の 4 か所の CC2 を落とす
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyDataStream` / 根拠: research A1
      依存: なし
      AC: AC2
- [x] T2: 単体テスト
      対象: `packages/tn5250/test/early-return-cc2.test.ts`
      依存: T1
      AC: AC2
- [x] T3: 実機の試験（DSM の EARLYROLL・ACS のプローブ・当 PJ の検証）と片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/early-return-cc2.txt`・`scripts/acs-probe/AcsProbe.java`・`scripts/verify-early-return-cc2.mjs`
      依存: T1
      AC: AC1, AC3
