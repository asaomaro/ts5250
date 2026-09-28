# 調査: 再順序付け

## 判明した事実
- F1（原典）: `DS5250` の SOH 分岐は長さが 3 以上なら本体 3 バイト目を `FFT5250.setResequenceNumber` に入れる。`processClearFMT`（CLEAR UNIT・CLEAR UNIT ALTERNATE・CFT・SOH）で 0 に戻す。
  `Field5250` は FCW の上位バイト 0x80 で `nextResequence = 下位バイト`
- F2（原典）: `FFT5250.firstModifiedField`: 再順序付けが 0 でなければ `elementAt(番号 - 1)`、MDT が無ければ `nextModifiedField`。
  `nextModifiedField(位置)`: その位置で始まる欄の `nextResequence` が 0xFF なら終わり、そうでなければ `elementAt(n - 1)`、それが MDT でなければ終わり（`continue` でループを抜ける）。
  n が 0 なら `elementAt(-1)` で例外（ACS 自身の欠陥）
- F3（原典）: `firstInputField` / `nextInputField`（READ INPUT 系）: 同じ鎖を MDT を問わず辿り、n が 0 なら表の次（`elementAt(i + 1)`）
- F4（原典）: `FFT5250.isValidCursorProgressField`: カーソル送りの欄は、再順序付けが 0 でなければ表に入れない（→ `processWriteToDisplay` が 0x10050125）
- F5（実機・ACS のコア。`scripts/acs-probe/resequence.txt`・DSM の RESEQ）: 鎖 #2(7,10) → #1(5,10) → #3(9,10)。3 欄に打つと `11070ac2 11050ac1 11090ac3`、#2・#3 だけ打つと `11070ac2`
- F6（実機・当 PJ。`scripts/verify-resequence.mjs`）: `11050ac1 11070ac2 11090ac3`・`11070ac2 11090ac3`（画面順・MDT の欄を全部）

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` `applySf` の FCW・`fieldAddFailure`（decisions D7 の「見ない」）
- A2: `packages/tn5250/src/screen/buffer.ts` `setHeaderData`・`clearFormatTable`・`clearUnit`・`clearUnitAlternate`・`InternalField`
- A3: `packages/tn5250/src/protocol/read-response.ts` の `buf.mdtFields()`（0x52・0x82・0x83）と `buf.orderedFields()`（平たい形）
