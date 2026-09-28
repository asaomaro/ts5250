# タスク: HLLAPI の AID の前の検査

## 実装方針
判定関数を出し、`sendKey` の AID の前に繋ぐ。実機スクリプトに AID の場合を足す。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 除外キーを取り違えない（ペインと同じ）

## テスト方針
- 単体・mutation・実機（ADJPGM）

## タスク
- [x] T1: `fieldViolation`・`mandatoryEnterViolation` を出す
      対象: `packages/server/src/hllapi-leave-check.ts`
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: `sendKey` の AID の前に検査する
      対象: `packages/server/src/hllapi.ts` `sendKey`
      依存: T1
      AC: AC1, AC2, AC3
- [x] T3: 実機スクリプトに AID の場合を足す・docs
      対象: `scripts/verify-hllapi-tab-mandatory.mjs` `docs/HLLAPI.md`
      依存: T2
      AC: AC1, AC3
