# レビュー: 符号付き＋RZ の欄の埋め字

## タスク点検ログ
- T1・T2・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC3 を単体と mutation で固定した。
- 価値適合: CHECK(RZ) の数値欄が ACS と同じ 0 埋めで見える。
- 正確性: RZ・RB を先に見て、符号付きなら符号桁を守る。符号付きで指定が無い・MF だけのときの空白右寄せは残した（無いと数値欄の Field Exit が何もしない）。
- 規約適合: 旧い決定（signed-num 優先）を、どの証拠で破棄したかを decisions D1 に書き、テスト・コメントに取り消し線で残した。
- 指摘なし。

## ラウンド 2（節目 11 の独立点検。`scratchpad/rv11/review-webui.md`。担当 B）
- [should] **B-S6** `packages/web-ui/src/composables/fieldEdit.ts`（`rightAdjust`）／`test/field-adjust.test.ts:49`: 空の RZ/RB 欄の Field Exit は、ACS では全桁が埋め字になる（原典 `PS5250.performRightAdjustFill`: 空きは「欄末尾から続く NUL の数」だけで、当 PJ の Field Exit が消したばかりの区間がそれに当たる）が、当 PJ は`rightAdjust`（GNU tn5250 `tn5250_display_shift_right` の移植）が「全桁が空白の欄は整形しない」（原典の無限ループ回避）としていたため、何もしなかった。台帳の残りにもこの差は挙がっていなかった（当時は原典の読みのみで未測定）。
  実機の ACS のコアで測った（`scripts/acs-probe/empty-adjust-field-exit.txt`）: 何も打たずに欄の先頭で Field Exit → 全桁が埋め字（`000000`。ホストが受け取った値も `000000`）。空の欄の途中（5 桁目）で → `00    `・2 桁目で → `00000 `（手前の空白は内容として一緒に右へ動く）。`1` と空白を 1 つ打って → `00001 `（打った空白は空きとして捨てず、内容として動く）。符号付き＋RZ を空のまま Field Exit → `000000 `（符号桁は空白のまま）。
  `rightAdjust` を「空きはカーソル以降（Field Exit が消した桁数）だけ」という規則に書き換えた（GNU tn5250 の移植は破棄。ACS が情報を捨てているケースではなく、逆に ACS の方が細かい規則を持っていた）。

対応: `rightAdjust` を ACS の規則で書き直し、実機の測定値で単体テストを再構成した（何も打たない・途中まで空・打った空白・符号付き＋RZ 等）。既存の `applyAdjust`/`fieldExit` の呼び出し側は変更なし。mutation 3 通りすべて検出。

## ラウンド 3（通過）
- ラウンド 2 の指摘（should 1）を直した。`rightAdjust` を ACS の規則に書き換え、実機の測定値でテストを再構成、mutation 3 通り検出。decisions D3 に破棄の根拠を残した。指摘なし。
