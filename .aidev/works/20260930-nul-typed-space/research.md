# 調査: 継続でない O 欄の空き（NUL）と空白

## 調査の問い
- Q1: O 欄・J・E に打った末尾の空白（半角・全角）を、ACS のコアは READ MDT・ALT でどう送るか
- Q2: 当 PJ は何を送っていたか

## 判明した事実
- F1（実機。`scripts/acs-probe/space-typed.txt`・DSM の SPACETY・2026-10-01）: 空の 12 桁の欄に打鍵した結果、O 欄 `A`＋空白は READ MDT・ALT とも `c1 40`（f3）、O 欄 `あ`＋空白は `0e 4481 0f 40 0e 0f`（f4。空白を打ったあとに打った字を Backspace した形）、半角の E `A`＋空白は `c1 40`（f2）
- F2（同）: J・全角の E に `あ`＋全角空白を打つと、READ MDT は空きの NUL の組も 40 40 になるので見分けがつかず（`0e 4481 4040…0f`）、ALT は打った全角空白が `4040`・詰め物が `0000`（`0e 4481 4040 0000… 0f`）。J の先頭に全角空白だけを打っても同じ（`0e 4040 0000… 0f`）
- F3（ブラウザで修正前に走らせた `scripts/verify-browser-space-typed.mjs`）: 修正前の当 PJ は、O 欄・半角の E の `A`＋空白を `c1`（空白を落とす）、J・E の打った全角空白を ALT で `00`（詰め物と区別できない）で送った
- F4（コード）: 送信の経路は空のセルと空白のセルを見分ける（`read-response.ts` の `sendValue`＝`cellAt === null`。`dbcsRawCell`＝生バイト）。落としていたのは web-ui の値の側（`trimPad` が末尾の空白を落とし、`padDbcs` が空白で詰める）と、core の `setFieldCells` が末尾の空白を空のセルにしていたこと（継続した O 欄の鎖は除外済み）

## 影響範囲
- web-ui: `ScreenGrid.vue`（`trimPad`・`padDbcs`・`logicalFromCells`・End キー・`displayText`・`normalizeO`）、`oFieldCells.ts`、`mandatoryCheck.ts`
- core: `buffer.ts` の `setFieldCells`・`setFieldValue`

## 実装アンカー
- A1: 値の詰め物と末尾（`ScreenGrid.vue` `trimPad`・`padDbcs`・`logicalFromCells`）
- A2: セルの詰め物（`oFieldCells.ts` の `toCells`・`del`・`insert`・`eraseToEnd`）
- A3: core（`buffer.ts` `setFieldCells`・`setFieldValue`）

## design への申し送り
- 継続した O 欄の鎖の仕組み（U+0000＝空き）をそのまま全 O 欄に広げる
- J・E（全角空白の詰め物）は詰め物と打った空白を区別する別の表し方が要る——この work の対象外
