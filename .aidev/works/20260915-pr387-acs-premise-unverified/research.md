# 調査: `PR#387` の ACS 前提が未検証だったことの裏付けと、正しい判定の再評価

## 調査の問い

- Q1: `PR#387`（保護欄で Enter 確定後にカーソルを先頭入力欄へ寄せる）の
  「ACS は下の入力欄にカーソルを入れる」という前提は、実際に ACS を動かして
  検証されたものか。
- Q2: ACS のデコンパイル済みコアには、この前提（「動いていない・いま保護化された」
  を検知して上書きする）に相当するロジックが実在するか。
- Q3: 上記が確認できない場合、コードの挙動をどう再評価すべきか。

## 判明した事実

- F1: **`PR#387`（コミット `c82e2b34`、GitHub PR #387）の本文・commit message の
  どちらにも、実際に ACS ソフトウェアを動かして CURSORCL3 シナリオと比較検証した
  記録が無い。** PR #387 本文の「検証資材」節が挙げる4スクリプトを確認した:
  - `scripts/build-cursortst.mjs`（実機にテスト画面を作るだけ、ACS 非関与）
  - `scripts/diag-cursor-after-expand.mjs`（このプロジェクトの `Session5250` 核の
    カーソル位置を実機ホストに対して測るだけ）
  - `scripts/diag-ic-on-protected.mjs`（同上、展開画面と SEU 走査を並べるだけ）
  - `scripts/verify-browser-focus-after-expand.mjs`（このプロジェクトの web-ui
    ブラウザの DOM フォーカスを Playwright で測るだけ——「ブラウザ」は
    このプロジェクトの意味で、IBM ACS を指さない）
  4つとも**このプロジェクト自身のクライアント**を対象にした計測であり、
  実際の ACS ソフトウェアには一度も接続していない（`gh pr view 387` で本文
  全文を確認、コメント欄も0件）。
- F2: **PR #387 本文の末尾に、未チェックのチェックボックスが残っている**:
  `- [ ] 報告された実際の画面で、Enter 後に下の入力欄へ入ること`
  ——利用者から実際に報告された本物の画面（合成テスト画面 `CURSORTST` ではなく）
  での確認自体が、当時完了しないままマージされていた（`gh pr view 387
  --json body` で確認）。
- F3: **`DS5250.preprocessWCC2(short)` の全文を読んだ（`.aidev/works/
  20260915-pdm-protected-cursor-pageup` research.md F9 で既に実施・記録済み。
  本 work のために再度デコンパイルし、同一の結果を再確認した）。** カーソル
  位置の決定はこの3パターンに完全に集約される（`acsbundle.jar` →
  `plugins/emulator/acshod2.jar` → `com/ibm/eNetwork/ECL/tn5250/DS5250.class`
  を CFR でデコンパイルして確認。抜粋:）
  ```java
  if ((this.pendingCCbyte2 & 0x40) == 0) {
      if (this.WTD_IC_addr == -1) {
          this.ps.setDefaultInsertCursor();
          n = this.ps.getHomePos();
      } else if (this.codepage.IsBIDIsession()) {
          n = this.ps.bdGetInsertCursor(this.WTD_IC_addr);
          this.ps.setInsertCursor(n);
      } else {
          n = this.WTD_IC_addr;
      }
      if (this.WTD_MC_addr != -1) {
          n = this.WTD_MC_addr;
      }
      this.ps.setCursorPosition(n);
  } else if (this.WTD_MC_addr != -1) {
      n = this.WTD_MC_addr;
      this.ps.setCursorPosition(n);
  }
  ```
  この後に続くのは、GUI 選択ウィジェット（ENPTUI選択欄）専用の狭い例外
  （新しい位置と直前の位置が**同じ選択欄**なら直前の位置へ戻す）だけであり、
  プレーンなテキスト欄（CURSORCL3 の CODE 欄、SEU の保護表示領域）には
  無関係。**「動いていない・いま保護化された」を検知して先頭入力欄へ上書きする
  ロジックは、このメソッドのどこにも存在しない**（Q2 の答え: 存在しない）。
- F4: 利用者自身も、「CURSORCL3 で ACS が下の入力欄へ寄せる」という記述について
  「当時ご自身で実機の ACS と比較して報告した記憶があるか」という問いに対し
  「不確かなので、いったん外して検証してほしい」と回答した（本セッション）。
  F1・F2・F3 と合わせ、Q1 の答えは「検証された記録は無く、利用者自身の記憶も
  不確かである」。

## 影響範囲

- `packages/tn5250/src/session/session.ts` の `handleRecord()` にある
  `PR#387` 分岐（`cursorBeforeWasEnterable && cursorAddr===cursorBefore &&
  cursorIsUnenterable()` → `cursorToFirstInputField()`）——F3 で確認した
  ACS コアの挙動と矛盾する（ACS コアはこの上書きを行わない）。
- `packages/tn5250/src/screen/buffer.ts` の `isEnterableAt()`——`PR#387` 分岐
  専用に追加したメソッドで、分岐を除去すれば呼び出し元が無くなる。
- `packages/tn5250/test/cursor-stale-on-protected.test.ts` の「カーソルが保護欄に
  取り残されたら最初の入力欄へ寄せる」describe ブロック（4テスト）——現在は
  「動いていない・保護欄→寄せる」を期待値にしている。分岐を除去すると、これらの
  期待値は逆転する（寄せない＝ホストの指定にそのまま従う、が正しい期待値になる）。
- `!result.cursorSet` の分岐（IC/MC が無ければ最初の入力欄）は対象外——F3で
  確認した通り、ACS コアの `WTD_IC_addr == -1` → `setDefaultInsertCursor()` と
  一致する、確認済みの挙動。

## 実現性 / リスク

- **実機 ACS による直接確認はこの work のスコープでは不可能**（この開発環境に
  ACS が無い。`.aidev/works/20260914-seu-page-cursor-hold` decisions.md D6）。
  したがって、「ACS が実際にこのシナリオでどう見えるか」は今回も確認できない
  ——確認できるのは「ACS のコアのコードに、この上書きに相当するロジックが
  無い」という事実だけである。この2つを混同しない。
- **`PR#387` の分岐を除去すると、その分岐が本来解決しようとした症状
  （利用者が Enter で確定した際、上の欄が保護化されカーソルが取り残され、
  Tab を押すまで入力できない）が再び起きる**。ただし、これは ACS コアが
  確認上そうする（IC をそのまま尊重する）以上、**ACS と異なる独自の親切
  ロジックを撤去して ACS 挙動に一致させる**という意味であり、単純な退行では
  ない——この理解を `decisions.md` に明記する。
- SEU の走査検索（動いた場合は元々この分岐の対象外）、F1ヘルプ・27x132切替
  （`!cursorSet` 分岐、対象外）には影響しない。

## 実装アンカー

- A1: `packages/tn5250/src/session/session.ts` の `handleRecord()`、`PR#387`
  分岐（`else if` 節）——削除対象。
- A2: `packages/tn5250/src/session/session.ts` の `cursorBeforeWasEnterable`
  計算箇所（`cursorBefore` 捕捉と同時に計算している行）——`PR#387` 分岐を
  削除すれば不要になるため、併せて削除する。
- A3: `packages/tn5250/src/screen/buffer.ts` の `isEnterableAt()`——呼び出し元が
  無くなるため削除する（`requirements.md` AC1 の指示通り）。
- A4: `packages/tn5250/test/cursor-stale-on-protected.test.ts` の1つ目の
  describe ブロック（4テスト）——期待値を書き直す。

## 実装時の注意

- **`cursorIsUnenterable()`（`buffer.ts`）自体は `PR#387` 分岐でのみ使われて
  いた**——`PR#387` 分岐を削除すると、このメソッドも呼び出し元が無くなる
  可能性がある。削除前に他の呼び出し元が無いか確認すること（`grep -rn
  "cursorIsUnenterable" packages/`）。
- 実装後は、`.aidev/works/20260915-pdm-protected-cursor-pageup` で確立した
  手法（実機での分岐別直接ログ・discrimination テスト）を踏襲し、削除後の
  コードでも CURSORCL3・SEU 両シナリオを実機で再確認すること。

## design への申し送り

- `PR#387` 分岐（F3 で確認した ACS コアの挙動と矛盾する上書きロジック）を
  `handleRecord()` から削除する。
- `cursorBeforeWasEnterable` の計算・`isEnterableAt()`（`buffer.ts`）は、
  `PR#387` 分岐でのみ使われていたため、他に使い道が無ければ併せて削除する。
- `!result.cursorSet` 分岐は変更しない（F3 で ACS コアと一致することを確認済み）。
- 既存テスト `cursor-stale-on-protected.test.ts` の1つ目の describe ブロックの
  期待値を、「寄せる」→「寄せない（ホストの指定にそのまま従う）」へ書き直す。
