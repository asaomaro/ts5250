# タスク: HLLAPI の Tab・Backtab・Home で欄を出るときの MF・自己点検

## 実装方針
検査の純関数を先に作り、`moveCursor` に繋ぐ。実機は ADJPGM で ACS の実測と比べる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- web-ui の判定と意味をそろえる（空白を空とみなす）

## テスト方針
- 単体: `leaveViolation` の条件・HLLAPI の @T/@B/@0 の rc とカーソル・後ろのキーが処理されないこと
- mutation で条件を壊して検出を確かめる
- 実機: ADJPGM に HLLAPI で AB@T / 欄頭からの @B / 欄の途中からの @B

## タスク
- [x] T1: `leaveViolation` を足す（MF・自己点検・同じ欄・保護欄・非表示・継続欄の MDT・符号の桁）
      対象: `packages/server/src/hllapi-leave-check.ts`（新規）
      依存: なし
      AC: AC2, AC3
- [x] T2: `moveCursor` の tab・backtab・home で検査し、違反なら欄頭・`rc=5`・以降を処理しない
      対象: `packages/server/src/hllapi.ts` `moveCursor` `sendKey`
      依存: T1
      AC: AC1
- [x] T3: 実機の検証スクリプト（ADJPGM・HLLAPI 経由）
      対象: `scripts/verify-hllapi-tab-mandatory.mjs`（新規）
      依存: T2
      AC: AC1, AC3
