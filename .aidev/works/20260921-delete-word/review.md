# レビュー: Delete Word と既定キーの訂正

## タスク点検ログ
- T1・T2・T3・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC5 を単体・結合と mutation で固定した。
- 価値適合: 語を消す習慣の Ctrl+Delete・Ctrl+Backspace で欄の残りや全欄が消えない。ACS と同じ範囲の語が消える。
- 正確性: 移行はキーごとに独立で、自分で変えた値・消した割り当てを壊さない。Ctrl+Backspace を未割り当てにしたことで生じる「ブラウザの語削除で <input> の値だけが変わる」経路を止めた（D4）。
- 規約適合: 測定を `scripts/acs-probe/delete-word.txt` に残した。過去の決定（`20260729-field-adjust-local-edit-keys` の既定・`20260921-operator-error-mode` のローカル編集キーの一括拒否）は D2・D3 で破棄した。README も直した。実機の識別子は書いていない。
- 指摘なし。
