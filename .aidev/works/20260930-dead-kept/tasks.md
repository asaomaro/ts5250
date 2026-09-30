# タスク: 死んだ桁を AID のあとも残す

## 実装方針
測る（CONTOD）→ core → web-ui → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- セルを読む箇所は `cellAt` に集まっている（直接 `this.cells` を読むのは数か所）。死んだ桁が通常のセルとして読まれないことをテストで固定する

## テスト方針
- core の送信・snapshot・web-ui の鎖・変異・実機

## タスク
- [x] T1: 死んだ桁が AID のあとも残るかを測る（DSM の CONTOD）
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/cont-o-dead-kept.txt`
      依存: なし
      AC: AC2
- [x] T2: core の死んだ桁のセル
      対象: `packages/tn5250/src/screen/buffer.ts` `packages/tn5250/src/screen/types.ts`
      依存: T1
      AC: AC1
- [x] T3: web-ui の読み戻し・テスト・実機
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `logicalFromCells` `packages/web-ui/test/o-chain-edit.test.ts` `scripts/verify-browser-cont-o-dead-kept.mjs`
      依存: T2
      AC: AC1, AC2
