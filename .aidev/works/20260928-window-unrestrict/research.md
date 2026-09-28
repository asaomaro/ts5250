# 調査: WDSF 0x52

## 判明した事実
- F1（原典）: `ENPTUI5250.unrestrictWindowCursor(n, data, LL - 4)`: 中身（class・type の後ろ）が 2 バイトでなければ `sense_code = 0x10050110`、2 バイトなら `enpwindow`（最後に作った窓）が制限つきなら外す
- F2（実機・ACS のコア。`scripts/acs-probe/window-unrestrict.txt`・DSM の WINRESTRICT / WINUNRESTRICT / WINUNRESTRICTBAD。ENPTUI を申告して 2 回）:
  制限つきの窓（(5,10)・深さ 5）の中の 7,14 から上を 5 回で 7,14（窓の中を回る）、0x52 の後は 2,14（窓の外へ出る）。中身 3 バイトはホストの次の読みが CPFA304（否定応答）。
  ENPTUI を申告しないと窓の構造体が作られず、制限も効かない（1 回目の測定。当 PJ は常に申告する）
- F3（当 PJ）: `wdsf-parser.ts` の `parseWdsf` は 0x52 を `unknown`、`wtd-applier.ts` の `applyWdsf` は警告だけ。窓の制限は画面の側（`EmulatorPane.vue` の `restrictCursor`）が矢印を閉じ込める

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wdsf-parser.ts` `parseWdsf`・`WdsfEvent`
- A2: `packages/tn5250/src/protocol/wtd-applier.ts` `applyWdsf`
- A3: `packages/tn5250/src/screen/buffer.ts` の窓（`guiWindows`）
