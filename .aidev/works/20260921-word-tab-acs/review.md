# レビュー: 語頭ジャンプ

## タスク点検ログ
- T1・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC3 を単体・ペイン結合と mutation で固定した。
- 価値適合: 日本語の画面で全角 1 字ごとに止まり、端で巻き戻る（ACS と同じ）。Alt+←/→ でも使える。
- 正確性: up/down（当 PJ 独自）と `wordRangeAt`（ダブルクリック）は変えていない。旧仕様の期待 2 件は D1 に記録して更新した。
- 規約適合: 測定を `scripts/acs-probe/tabword.txt` に残した。過去の決定（語 = 非空白桁の連なり）は D1 で破棄した。
- 指摘なし。

## ラウンド 2（節目 11 の独立点検。`scratchpad/rv11/review-webui.md`・`review-core.md`。担当 A・B）
- [nit] **N1**（README.md）: Ctrl+矢印の説明（51・414 行）が「全角 1 字ごと・画面の端で巻き戻る」規則と Alt+←/→ の追加に追随していなかった。既定キーの一覧（473 行）に Ctrl+Home・Ctrl+F11 も無かった。3 か所に追記した。
- [nit] **N2**（`packages/web-ui/src/composables/useKeymap.ts:85`・`components/EmulatorPane.vue:843`）: 「Alt+矢印はペイン移動」という古いコメントが、Alt+←/→ を語頭ジャンプに割り当てた後も残っていた（実際のペイン移動は Alt+Shift+矢印）。2 か所を直した。
- [nit] **B-N9**（decisions.md D3）: 「文字が行末から次の行へ続く画面の行頭」を未確認としていたが、`ECLPS.getPreviousPosition` を原典で読んで確認できる（AGENTS.md 判断の原則 1）。DBCS の後ろに SI の無い半角の語頭は引き続き未確認のまま残した。

対応: README・コメント・decisions.md を実態に合わせた。コードの変更は無い。

## ラウンド 3（通過）
- ラウンド 2 の指摘（nit 3）を直した。README・コメント・decisions.md を直し、関連テスト 57 件を確認。指摘なし。
