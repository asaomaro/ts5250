# 調査: Field Exit 必須の欄（FER・RZ・RB・符号付き数値）

## 判明した事実
- F1（原典）: `Field5250.isFieldExitRequired` は `isFieldExitRequiredField`（FER）∨ `isRightAdjustBlankFillField`（RB）∨
  `isRightAdjustZeroFillField`（RZ）∨ `isSignedNumericField` を返す。`PS5250.processCharKeyStroke` は、Field Exit 必須の欄の
  最終桁まで打つと `setFieldExitReqFlag(true)` と `fieldExited = true` にして欄に留まる（自動送りしない）。
- F2（実機。`20260921-aid-without-field-exit` research F2）: RZ(A) を満杯（6 桁）まで打つとカーソルは欄の最終桁（3,25）に留まり、
  Enter は送れた（場合 10）。~~符号付き 6S0 の数字桁を満杯（5 桁）にすると符号桁（19,25）に留まり、Enter は 0020（場合 11）。~~
  → **読み違い**（独立点検の指摘）: 6S0 はワイヤ上で 7 桁（数字 6 桁＋符号桁。`20260729-field-adjust-local-edit-keys` research）。
  場合 11 は 6 桁中 5 桁しか打っておらず、(19,25) は符号桁ではなく 6 桁目。数字桁をすべて打った場合は下の F4 の場合 A。
- F3（当 PJ）: 自動送りは FER ビットだけを見ていた（`ScreenGrid.vue` `advanceIfFull`・`dupKey`）ので、RZ/RB を満杯まで打つと次の欄へ
  送り、自動 Enter 欄なら Enter を送っていた。符号付き数値は数字桁を埋めても符号桁に留まり、自動送りは起きていなかった
  （Field Exit 必須の判定を FER ビットだけに戻す改変でも、符号付きの 0020 のテストは通った）。

## 独立点検の後の実測（2026-09-21・`scripts/acs-probe/field-exit-full.txt`）

節目の独立点検（別コンテキスト）が原典から 4 点を指摘した。どれも**実機の ACS で確かめた**。画面は ADJPGM と、
ULKPGM に足した DUP（`scripts/build-ulktest.mjs`。5,20=CHECK(RZ) DUP / 7,20=素 / 9,20=CHECK(ER) DUP）。

- F4（場合 A・B）: **6S0 に 6 桁**打つとカーソルは 19,25（最終の数字桁）に留まり、**Enter は送れた**。
  CHECK(RZ) 6 0（数値。これも符号付き＝7 桁）に 6 桁打っても 15,25 に留まり、送れた。
  原典 `processCharKeyStroke`: 符号付きは `n4 = endPos - 1`、`cursorSBA == n4` で `fieldExited = true`（カーソルは進めない）。
- F5（場合 C）: RZ(A) を満杯まで打つと 3,25 に留まる。**そこで X を打つとエラー**（inhibit=5）、値は変わらず、
  文言は「フィールドを終了するために使用したキーが正しくない。」（`setErrorCode(24)`＝0x18＝**0018**）。
- F6（場合 D）: 満杯 → **Backspace** で 3,24 へ移り**カーソルの前の桁**が消えて `12346`、そのまま Enter は**エラー（0020）**。
  原典: Backspace の `setMDT` が `fieldExitReqFlag` を下ろし、文字以外のキーの後は `fieldExited = false`（`keyDown` の末尾）。
- F7（場合 E）: 満杯 → **左矢印でカーソルは動かず**（3,25 のまま）、Enter は**送れた**。
  原典 `processCursorMove`: `n == 1006 && fieldExited` なら `fieldExited = false` にするだけ。フラグは満杯のときに立っている。
- F8（場合 G）: CHECK(RZ) DUP の欄で `12`＋Dup → **次の欄（7,20）へ移った**。CHECK(ER) DUP の欄で `1`＋Dup → **送信**。
  原典 `processDupFM`: 自動 Enter 欄なら `processAID(10)`、それ以外は `nextNonByPassInputFieldPos` と `setFieldExitReqFlag(true)`。
  **FER も `isFieldExitRequired` も見ない**——当 PJ の「FER 欄は Dup の後も留まる」（GNU tn5250 由来）は ACS と逆だった。
- F9（原典）: `fieldExited` のまま Field Exit / Field± を押すと `eraseToEOF` をしない（`!fieldExited && !eraseToEOF(...)`）。
  最終桁は残る。符号付きの Field Exit は符号桁を消し、Field− は `-` を置く。Dup は `fieldExited` を見ずにカーソルの桁から埋める。
- F10（場合 F・H）: 操作員エラーの間に Field Exit・Erase EOF・Erase Input・Erase Field・Field+・Field−・Field Mark・Dup を押すと、
  **どれも欄を変えずエラーのまま**（inhibit=5）。原典 `PS5250.keyDown` の拒否の一覧と一致（`20260921-host-error-mode` 側で直す）。
  ⚠ 1 回目の実行では、エラー中の `[dup]` の後で ECL が応答を返さず止まった。2 回目（手順の最後に置いた）は返った。
