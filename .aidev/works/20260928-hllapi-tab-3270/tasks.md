# タスク: HLLAPI の 3270 のセッションの Tab・Backtab

## 実装方針
純関数を作って `moveCursor` の 3270 の分岐に繋ぐ。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 5250 の経路（`home` あり）を変えないこと

## テスト方針
- 単体（関数と HLLAPI の @T/@B）・mutation・実機（3270 のメインメニューで ACS と同じ）

## タスク
- [ ] T1: `tabPosition3270` / `backtabPosition3270`
      対象: `packages/server/src/hllapi-3270-tab.ts`（新規）
      依存: なし
      AC: AC1, AC2
- [ ] T2: `moveCursor` の tab・backtab で 3270 のときに使う
      対象: `packages/server/src/hllapi.ts` `moveCursor`
      依存: T1
      AC: AC1, AC2, AC3
- [ ] T3: 実機の検証スクリプト
      対象: `scripts/verify-hllapi-tab-3270.mjs`（新規）
      依存: T2
      AC: AC3
