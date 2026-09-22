# レビュー: Delete Word と既定キーの訂正

## タスク点検ログ
- T1・T2・T3・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC5 を単体・結合と mutation で固定した。
- 価値適合: 語を消す習慣の Ctrl+Delete・Ctrl+Backspace で欄の残りや全欄が消えない。ACS と同じ範囲の語が消える。
- 正確性: 移行はキーごとに独立で、自分で変えた値・消した割り当てを壊さない。Ctrl+Backspace を未割り当てにしたことで生じる「ブラウザの語削除で <input> の値だけが変わる」経路を止めた（D4）。
- 規約適合: 測定を `scripts/acs-probe/delete-word.txt` に残した。過去の決定（`20260729-field-adjust-local-edit-keys` の既定・`20260921-operator-error-mode` のローカル編集キーの一括拒否）は D2・D3 で破棄した。README も直した。実機の識別子は書いていない。
- 指摘なし。

## ラウンド 2（節目 11 の独立点検。`scratchpad/rv11/review-webui.md`。担当 B）
- [should] **B-S4**（一部）`packages/web-ui/src/stores/keybindings.ts`: 既定バインドの最新の版の数え方（`BINDINGS_VERSION`）が「追加・訂正の両方の版の最大」を直書きしており、**追加が無く訂正だけの版**を数える形を関数として固定するテストが無かった（59d98b85 で `ADDED_BY_VERSION[5]` が足されたため今は表面化していないが、将来「訂正だけの版」が来ると壊れかねない構造）。数え方を `latestBindingsVersion` 関数へ切り出し、追加のみ・訂正のみ・両方のケースでテストを固定した。
- [should] **B-S4**（一部）`packages/web-ui/src/components/ScreenGrid.vue`（`deleteWordKey`）: 満杯まで打った直後の「出た」状態（`fieldExitedIndex`）が、文字以外のキーの後で下りることは Delete Word 経由では固定されていなかった。テストを足した。

対応: `latestBindingsVersion` を関数化してテストで固定し、Delete Word が「出た」状態を下ろすことをテストで固定した。

## ラウンド 3（通過）
- ラウンド 2 の指摘（should 2）を直した。`latestBindingsVersion` の関数化と「出た」状態のテストで固定。指摘なし。
