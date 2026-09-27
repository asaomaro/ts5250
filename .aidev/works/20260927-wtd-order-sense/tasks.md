# タスク: WTD の中のオーダーの誤り

## 実装方針
検査と否定応答、テスト、実機の検証。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 偽の否定応答を作らない（D1・D2）。

## テスト方針
- tn5250 全体と `wtd-order-sense.test.ts`。変異: 各検査の閾値。

## タスク
- [x] T1: `fail`・`inScreen` とオーダーの検査、主ループの打ち切り
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWtd`・`applyDataStream` / 根拠: research A1
      依存: なし
      AC: AC2
- [x] T2: 単体テスト
      対象: `packages/tn5250/test/wtd-order-sense.test.ts`
      依存: T1
      AC: AC2
- [x] T3: 実機の試験（DSM の WTDERR*・ACS のプローブとワイヤ・当 PJ の検証）と片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/wtd-order-sense.txt`・`scripts/verify-wtd-order-sense.mjs`
      依存: T1
      AC: AC1, AC3
