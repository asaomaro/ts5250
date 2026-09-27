# タスク: WEA の否定応答

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 実機のトレースで WEA のタイプ 5 以外が来ていれば偽の否定応答になる（台帳: 実機のトレースで WEA は観測されていない。ACS も同じく否定応答にする）

## テスト方針
- 単体（ACS の値）・変異・実機

## タスク
- [x] T1: `case ORDER.WEA` の 3 つの否定応答と `SENSE`
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: テスト（既存の 2 件を ACS に合わせて書き換え・種類のテスト）と実機の検証（DSM のモード・プローブ・検証スクリプト）
      対象: `packages/tn5250/test/wtd-applier.test.ts`・`dbcs-pure-field.test.ts`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/wea-sense.txt`・`scripts/verify-wtd-order-sense.mjs`
      依存: T1
      AC: AC1, AC2, AC3
