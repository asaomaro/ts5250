# 調査: 継続した O 欄の貼り付けと単独の SO/SI の Delete

## 調査の問い
- Q1: 単独の SO/SI で Delete したとき、ACS のコアは詰め直しを回すか（死んだ桁の有無で結果が変わるか）
- Q2: 貼り付けの P3 で ACS が置く形（区間・字・カーソル）

## 判明した事実
- F1（実機。`scripts/acs-probe/cont-o-lone-shift.txt`・DSM の CONTOX・2026-10-01）: 先頭 `SO あい SI X` の鎖で、SO・SI での Delete は `0e448244840fe740e8e9` のまま（値は同じ）だが欄は MDT のまま送られた（D1・D2。D5・D6 は 2 回押しても同じ）。カーソルは動かない
- F2（同 D3・D4）: SO の次・SI の次での Backspace は何も送らない（欄に MDT が立たない）
- F3（同 D7・D8）: 全角の挿入で死んだ桁を作ってから（C02 と同じ）SI・SO で Delete すると、死んだ桁が捨てられ SI と SO の間が繋がる（`0e 4482 4484 4484 0f e7 40 e8 e9`）。カーソルは押した桁のまま
- F4（`scripts/acs-probe/cont-o-paste.txt` の P3。`20260930-cont-o-nul` research F3）: `AあBいCう` の貼り付けは `c1 0e4481 0f c2 0000 | 0e4482 0f` で止まる（い が次の区間の頭に置かれ、そこで止まる）。ホストが受け取る値が打鍵 P7 と最初の 4 字で同じ
- F5: 当 PJ の貼り付けは区間の中だけ（`dbcsType` の 1 字ずつの経路で、鎖をまたがない）。単独の SO/SI の Delete は 0065 で値を変えなかった（`chainDelete` の `k === 0`）

## 影響範囲
- `packages/web-ui/src/composables/oChainCells.ts`（`chainDelete`・`chainBackspace`・新規 `chainPaste`）
- `packages/web-ui/src/components/ScreenGrid.vue`（貼り付けの配線・エラーの出し方）

## 実装アンカー
- A1: 鎖の Delete（`oChainCells.ts` `chainDelete` の `k === 0`）
- A2: 貼り付け（`ScreenGrid.vue` `onInputPaste` の DBCS 単一行の枝）
- A3: 鎖の操作の反映（`ScreenGrid.vue` `oChainApply`）

## design への申し送り
- 貼り付けは打鍵と同じ鎖の操作を通す。止める条件は「カーソルが最初の区間を出た」
- 単独の SO/SI の Delete は結果に「エラー」も持たせる（値を反映したうえで理由も出す）
