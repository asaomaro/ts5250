# 調査: SSLD

## 判明した事実
- F1（原典 `PrintSCS5250JPS.processSetSingleLineDistance`）: 長さ（`2B D2` の次のバイト）が 4 でなければ受けない。幅は次の 2 バイトの `makeWord`（short）で、1〜32767 のときだけ `JPSSingleLineDistance` を積む。
- F2（原典 `JPSSingleLineDistance.process`）: `jPSState.getX() != 0` なら `JPSCarriageReturn` と `JPSLineFeed` を処理してから行送りの幅を変える。
- F3（当 PJ）: `scs.ts` の `skip2b` は D2 を長さぶん読み飛ばすだけ。CR は `col = 1`、LF は `row += 1`（桁はそのまま）。x が 0＝`col === 1`。
- F4（実機）: 行の途中に SSLD を置く帳票をホストに作らせる手段は見つかっていない（ホストの SSLD はページの頭で出る。台帳の実採取 3 件も行の頭）。**未実測**（原典だけ）

## 実装アンカー
- A1: `packages/scs/src/scs.ts` `skip2b`・呼び出し側（`case ORDER_2B`）
