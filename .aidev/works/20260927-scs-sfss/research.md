# 調査: SCS の SFSS

## 判明した事実
- F1: ACS `PrintSCS5250JPS` の `2B FD` は +3 の副コードで振り分け、0x02 が `processSetFontSizeScaling`: 長さ（+2）が 2〜4 のときだけ、横を +4、縦を +5（長さ 3 以上）から読み、`JPSFontSizeScaling(横, 縦)` を積む。長さ 2 でも +4 を読む（命令の外）
- F2: `JPSFontSizeScaling.mapScalingFactor`: 8 → 0.5、32 → 2.0、それ以外 1.0。`JPSState.setFont` が倍率を持ち、`JPSPrintableCharacters.process` は字の進みを `getCharAdvance() × getWidthScale()` にする。`JPSSpace`（空白・透過の 0x40）と `JPSHorizontalTab` は `JPSPrintableCharacters` を継ぐ。`JPSShiftIn` は倍率を見ない
- F3: 当 PJ（直す前）: `skip2b` は FD の 0x02 をバイト数だけ読み飛ばしていた（`packages/scs/src/scs.ts`）

## 実装アンカー
- A1: `packages/scs/src/scs.ts` の `put`・`putWide`・HT・TRN・`skip2b`
