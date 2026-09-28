# 調査: J・全角の E の欄の送るバイト列

## 調査の問い
- Q1: ACS は J・全角の E の欄で、編集の後にどんなバイト列を送るか
- Q2: 当 PJ の送る値はどこで組まれ、ACS とどこが違うか

## 判明した事実
- F1: 実機の ACS のコア（`scripts/acs-probe.mjs`＋`scripts/acs-probe/je-field-edit.txt`。DSM の JEEDIT〔`scripts/host-src/dscmd.c` の `JEEDIT`〕に 8 欄×3 巡・23 通り）で、
  ホストが受け取った READ MDT は次のとおり（2026-09-28 測定。`scripts/verify-browser-je-field.mjs` の `ACS` 定数）:
  - J1 `11030a0e448144824040404040400f…`（J の欄は編集後も SI が欄の最後の桁、空きは `40 40`）
  - J2 `…110b0a0e448244810f…`（ホストが `SO あ SI` と書いた E は、挿入で SI が中身の直後のまま動く）
  - J3 `…110b0a0e4482110d0a0e4481…`（`SO あ SI` の E を中身の中から消すと SI も消え、その後に打った字にも SI が付かない）
- F2: 23 通りはすべて、欄の「形」3 つで説明できる——
  **full**（SI が欄の最後の桁。J の欄は常に、半角から全角へ切り替えた E も）/ **compact**（SI が中身の直後。ホストが中身の直後に SI を書いた E）/
  **open**（SI が無い。compact の E を SI 以前から消去したとき）。消去・挿入・削除は両端の 1 桁の内側で行われる（ACS `PS5250` の `eraseToEOF_Work` / `eraseField_Work`・DBCSPlane を消さない）。
  full は複数の欄・複数の巡（J1 の 1・2・3・4 欄目、J2・J3 の J 欄）で観測したので、1 回の観測ではない（条項 `measurement-sanity`）
- F3: 当 PJ の変更前のブラウザの送信は、構造だけが違った: SI を常に中身の直後に置き（J の欄が compact になる）、E を消去した後にも SI を足していた
  （同じ `verify-browser-je-field.mjs` の変更前の実行）
- F4: 画面の側は編集の模型を字だけの論理値で持ち、`edits` の値は多くの箇所（基準値の比較・表示・貼り付け・テスト 30 件）が論理値を前提にしている——
  `edits` に印入りの値を入れると web-ui のテストが 30 件落ちた（本 work の最初の試み）
- F5: コアは印入りの値を `setFieldValue` → `setFieldCells` で構造どおりのセルに置く（`packages/tn5250/src/screen/buffer.ts` の `setFieldCells`）。
  並びの中の NUL（`DEAD_MARK`）は変更前は DBCS の前半バイトとして読まれていた（`inShift && lead === undefined`）

## 実装アンカー
- A1: 画面の側の欄の形と送る値（`packages/web-ui/src/components/ScreenGrid.vue` の `eitherDbcsOn` 付近・`syncDbcs`・`eraseInputKey`・`eraseToEndDbcs`・`pasteFrom`）
- A2: 送る値の持ち回り（`packages/web-ui/src/stores/sessions.ts` の `SessionState`・`EmulatorPane.vue` の `onEdit`・`session-controller.ts` の fields 組み立て）
- A3: コアのセル化（`packages/tn5250/src/screen/buffer.ts` の `setFieldCells`）

## 実装時の注意
- 空の E の `0e` は `eitherDbcsOn` を受けたコアが置く（`20260927-either-field-so`）——空の値に印を付けると二重になる
- 新しい画面では形を捨てる（`eitherSwitched` と同じ寿命）

## design への申し送り
- 送る値は `edits` と別に持つ（F4）
