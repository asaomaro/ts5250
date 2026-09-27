# タスク: 長さの足りないコマンドの否定応答

## 実装方針
`tooShort` と 4 つの入口、テスト、実機の検証。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 0x22 の 0 バイトの既存テストが変わる（D1）。

## テスト方針
- tn5250 全体。変異: 各入口の検査を外す。

## タスク
- [x] T1: `tooShort` と 4 つの入口
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyDataStream` / 根拠: research A1
      依存: なし
      AC: AC2
- [x] T2: 単体テスト（6 形と対照・0x22 の 0 バイト）
      対象: `packages/tn5250/test/early-return-cc2.test.ts`・`packages/tn5250/test/window-error-code.test.ts`
      依存: T1
      AC: AC2
- [x] T3: 実機の試験（DSM の SHORT*・ACS のプローブ・当 PJ の検証）と片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/short-command-sense.txt`・`scripts/verify-short-command-sense.mjs`
      依存: T1
      AC: AC1, AC3
