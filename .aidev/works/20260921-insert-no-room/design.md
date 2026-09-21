# 仕様: 挿入モードの余地を ACS と同じに数える

## 設計方針
- `fieldEdit.ts` に `insertChar(state, ch, lastTypeable)` を足す（`EditState | undefined`）。カーソルが欄の最終桁（`chars.length − 1`）以上、
  または `chars[cursor..lastTypeable]` の末尾に続く空白が 0 なら `undefined`。余地があれば `cursor` に入れ、`lastTypeable` の空白を 1 つ
  落とす（符号桁は動かない）。空白は `" "` と NUL。
- 打鍵（SBCS）: 挿入モードで選択の置換でないとき、型の検査のあと・符号桁の検査の前に `insertChar`。`undefined` なら `MSG_NO_ROOM` を出して
  値を変えない。符号付きの最終の数字桁に入れたらカーソルは符号桁へ進め、「出た」状態にする（F2）。「出た」後の文字が 0018 になるのは
  カーソルが最終の数字桁にあるときだけ（挿入で符号桁へ進んだ後は 0012）。
- 継続欄: `editAcrossContinued` の `apply` が `undefined` を返したら何もせず `false` を返すようにし、挿入は合成バッファに
  `insertChar(…, 全長−1)` を当てる。挿入の後に区間の終わりへ着いたら次の区間の先頭へ（`preferNext`）。
- IME 確定（SBCS）: 挿入モードでは `insertChar`。入らなくなった字で止め、`MSG_NO_ROOM` を出す。
- DBCS 欄: 挿入モードで `dbcsType` が `undefined` なら `MSG_NO_ROOM` を出す（値は従来どおり変えない）。

## 依拠する既存の事実
- `lastTypeable(f)`（`ScreenGrid.vue`。符号付きは符号桁の手前）・`fieldExitedIndex`／`field-exited`（`20260921-field-exit-required-types`）。
- `MSG_NO_ROOM` は `isOperatorError` に入っている（`opMessages.ts`）＝ACS と同じくエラー状態に入り、挿入モードが解ける（既存の配線）。
- 貼り付けは `insertInto` で別に判定している（変えない）。

## 受け入れ基準との対応
- AC1: `field-edit.test.ts`（純関数）と ScreenGrid のテスト（素の欄・行をまたぐ欄。通知と値）。
- AC2: 同（符号付き）。
- AC3: 継続欄・IME・DBCS のテスト。
- AC4: mutation。
