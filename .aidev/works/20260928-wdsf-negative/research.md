# 調査: WDSF の構造体ごとの否定応答

## 判明した事実
- F1（原典 `ENPTUI5250.processWSFOrder` と各構造体。抜き書きは scratchpad の `wdsf-sense-diff.md`）: 選択欄・窓・スクロール・バーは `checkMajorLength`（LL がそれぞれ 20・8・14 以下で 0x10050113）、
  0x55 は LL<7 か (LL−3)%4≠0、0x58・0x5B は LL≠6、0x59・0x5F は LL≠7、0x60 は LL<9 か 12〜17、0x61 は LL≠11 で 0x10050110。0x60・0x61 の区画（4 バイト目）が 1 でなければ 0x10050112、
  0x61 の行・桁が 0 か画面の外、幅・深さが 0 か画面の外へはみ出せば 0x10050151。否定応答は WTD を打ち切る。
- F2（実機・ACS のコア・2026-09-28。DSM の WDSFNEG・`scripts/acs-probe/wdsf-negative.txt`）: N01〜N14 のホストの読みがすべて CPFA304、正しい 0x5F（N15）は rc=0。
- F3（当 PJ）: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWdsf` は頭の検査と 0x52 の長さだけ。

## 実装アンカー
- A1: `wtd-applier.ts` `applyWdsf`（型の検査の直後）・`SENSE`
