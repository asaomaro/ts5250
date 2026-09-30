# 調査: 死んだ桁は AID のあとも残るか

## 調査の問い
- Q1: ホストが画面を書き直さない場合、ACS は AID のあとも死んだ桁を保つか

## 判明した事実
- F1（実機。`scripts/acs-probe/cont-o-dead-kept.txt`・DSM の CONTOD・2026-10-01）: 鎖の X に全角 え を挿入（死んだ桁ができる）して Enter（E1 `0e448244840f40400e44840fe740e8e9`・カーソル 6,13）、ホストは解錠だけの WTD を送り、SI で Delete して Enter（E2 `0e4482448444840fe740e8e9`・カーソル 5,15）。E2 は書き直した画面での結果（`cont-o-lone-shift.txt` の D7）と同じ＝死んだ桁が残っていて詰め直しで捨てられた
- F2（コード）: 当 PJ の core は死んだ桁の印（値の U+0000 の印）を空のセルに置いていた（`buffer.ts` の `setFieldCells`）ので、AID のあとの画面は空きとして読み戻した

## 影響範囲
- `packages/tn5250/src/screen/buffer.ts`・`types.ts`、`packages/web-ui/src/components/ScreenGrid.vue`

## 実装アンカー
- A1: `buffer.ts` `setFieldCells`（死んだ桁のセル）・`cellAt`・`dbcsRawCell`・snapshot
- A2: `ScreenGrid.vue` `logicalFromCells`

## design への申し送り
- 空のセル（null）と別のセルにして、NUL に見せる読み口（`cellAt`）を 1 か所に集める
