# 調査: 継続した O 欄の空きと空白

## 判明した事実
- F1（実機。`scripts/acs-probe/cont-o-edit.txt` の C09・C10・2026-09-28）: 空白で埋めた鎖への挿入は、末尾の空白 6 つを中身として最終区間へ押し出して送る（`…e7 40 e8 e9 40×6`）。空きで埋めた鎖（C01・C02）は押し出さない。
- F2（実機。`scripts/acs-probe/cont-o-paste.txt`・DSM の CONTOP・2026-09-30）: READ MDT ALT で、貼り付け・打鍵とも途中の空き・死んだ桁は `00`（P3・P4・P7・P8）。当 PJ は `40` だった（空きを半角空白で持つため）。
- F3（同 P1〜P4）: 貼り付け（GUI の Ctrl+V の入口 `ECLPS.pasteLineWrap`）は最初の区間で止まる——全角 8 字は 3 字（SO あいう SI）、半角 16 字は 8 字、区間の途中からの貼り付けも同じ形。当 PJ は P1・P2・P4 が既に同じ。P3（全角が区間の残り 2 桁に入らない）は、ACS は次の区間の頭へ置く（そこで止まる）が、当 PJ は置かない。
- F4（原典 `insertChar` の操作表）: `putSBChar(n, ' ')` は空白（0x40）を置く操作で、空き（NUL）とは別。詰め直し（`checkWordsFitDBCSOpenContField`）は末尾の 0x00 だけを余地とする（既存の `isFree` の読み）。
- F5（当 PJ の差）: web-ui の O 欄の値は空きも空白も " "。core の `setFieldCells` は末尾の空白を空のセルにする。
- F6（手掛かり）: snapshot のセルは、ホストが書いた空白に生バイト 0x40 を持つが、書かなかった桁（空のセル）は持たない（`wtd-applier.ts` の `setChar(addr, ch, b)`）。core が打った空白に 0x40 を持たせれば、web-ui が読み直しても見分けられる。

## 実装アンカー
- A1: `packages/web-ui/src/composables/oFieldCells.ts`（`OCell.nul`・`toCells` の `padNul`・`fromCells`・`eraseToEnd` の `fill`）・`oChainCells.ts`（`empty`・`isFree`・`Tok.nul`）
- A2: `packages/web-ui/src/components/ScreenGrid.vue`（`trimPad`・`logicalFromCells`・`padDbcs`・`oChainApply`・`fillFollowingSegments`）・`fieldValidate.ts`（`viewChar`）
- A3: `packages/tn5250/src/screen/buffer.ts`（`setFieldCells`・`setFieldValue`）
