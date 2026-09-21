# レビュー: 継続欄の Erase EOF・Field Exit・Field±・Dup

## タスク点検ログ
- T1・T2・cross: 同じセッションで差分を読み直した。指摘なし。

## ラウンド 1（同じセッション。独立点検は節目で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（gap 0）。AC1〜AC4 を単体 16 件と mutation で固定した。
- 価値適合: 日付欄・メモ欄の途中の Erase EOF・Field Exit が後ろの区間まで消え、Field Exit の後のカーソルが鎖の後ろに着く（ACS と同じ）。
- 正確性: 続く区間の消去は直接コミットで、カーソルの区間は従来の編集モデル（右寄せはその区間だけ）。行き先は `leaving` を付けた 3 つのキーだけで、打鍵の満杯・ホストのカーソル送りは変えない。
- 規約適合: 測定を `scripts/acs-probe/continued-field-erase-exit.txt` に残した。DUP 可の継続欄の画面は `scripts/build-ulktest.mjs`（測った後に `--clean` で消す）。実機の識別子は書いていない。
- 指摘なし。
