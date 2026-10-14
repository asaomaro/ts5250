# decisions: 文字端末の前面（第 1〜3 段）

- D1: パッケージは `@ts5250/terminal`、`bin` は `ts5250-term`。依存は `base` と `tn5250` だけ（hostserver / tn3270 / vt / scs / ebcdic と同位。`dependency-direction.test.ts` に宣言）。
- D2: 接頭キーは `Ctrl+]`（tmux の Ctrl+B・screen の Ctrl+A と衝突しない）。`--prefix` で変えられる。利用者が決めなかったので既定を置いた——**変えてよい**。
- D3: 下線・桁区切りは DDS 準拠（利用者の判断）。`underline` → 実線、`columnSeparator` のみ → `4:4`。代替の見せ方は持たない。
- D4: 第 1 段の入力は SBCS の上書きのみ。全角・DBCS 欄・挿入は編集ロジックの切り出し（第 2 段）まで受けない（`note` で知らせる）。web-ui の編集を写し直さない。→ 第 3 段（D7）で解除。
- D5: 非 ASCII は 1 字ごとに CHA で桁固定。**試験が全角の右半分の二重計上（以降の桁が 1 字ごとに 1 桁ずれる）を捕まえた**——試作と同じ誤りを本実装でも書いており、`frame.test.ts` の「全角は CHA で桁を固定」で固定した。
- D6: `--replay <jsonl>` を CLI に足した（ホスト不要の確認・画面撮影用）。実機接続は利用者の設定の範囲でだけ。
- D7: 編集は `@ts5250/tn5250/edit/*`（第 2 段で web-ui から移した純関数 8 本）を呼ぶ。バレルは作らずファイル単位のサブパスで公開する（`fieldEdit` と `oFieldCells` の `del`・`backspace`・`eraseToEnd` が同名のため）。端末側の糊は `app/editing.ts` に限り、Vue・DOM に触れない。
- D8: 第 3 段の対象は通常の文字欄（行をまたぐ欄を含む）と O 欄。継続欄（鎖）・語送り・J・E・G は web-ui が専用の経路を持つので、端末版は「未対応」と知らせて値を変えない（黙って違う結果にしない）。
- D9: 挿入モードは AID の送信で上書きへ戻す（5250 の慣習）。状態行に「挿入」を出す。
- D10: 満杯で次の入力欄へ進む／Field Exit 必須欄で留まって次の字をエラーにする、は web-ui の `ScreenGrid` の規則（ACS `fieldExited`）に合わせた。
- D11: メッセージ文言は web-ui の `opMessages.ts` と同じ語を `editing.ts` に置いた。**文言が 2 か所にある**ので、web-ui 側が変わったら追従が要る（`opMessages` を tn5250 へ移す案は未決）。

## 第 4 段（`ts5250` / `ts5250ctl`。利用者の依頼 2026-10-14）
- D12: 新パッケージ `@ts5250/cli`（bin `ts5250`・`ts5250ctl`）。terminal が server に依存しない向きを守るため、両方に依存する薄い入口を別に置いた。`private`。
- D13: `ts5250` はサーバーを**子プロセス**で起動し、WebSocket に繋ぐ。`main.ts` が起動関数を公開していないこと・ログが stderr で端末に混ざることが理由。起動引数は `start.sh` と同じ（`.env` があれば `--env-file`、`profiles.local.json` → `profiles.json`）。サーバー本体のポート指定は `--http <N>` なので、`--port` を直して渡す。
- D14: 端末の接続は 2 通り（直接 `Session5250`／サーバーの WebSocket）。WebSocket 側は `WsSession`（terminal の transport）。**打った値は AID を送るまで手元に持ち、`key.fields` でまとめて渡す**（web-ui と同じ約束）。描画と編集の入力には `overlayField` で重ねた画面を使う。画面が替わったら編集値は捨てる（欄の番号が別物のため）。
- D15: `ts5250ctl` は MCP のクライアント（Streamable HTTP）。ツール一覧・入力スキーマはサーバーから取り、型は `type` で変換する（数・真偽・JSON）。専用のサブコマンドは持たない（ツールが増えても追従不要）。
- D16: 当初の「`--profile` で `profiles.local.json` を読む」は不要になった。サーバーの `ConfigResolver` が暗号化パスワードの復号まで行うので、`ts5250 [セッション名]` がそれを使う（実機 PUB400 でサインオン済みのメニューまで確認）。

## 第 5 段（継続欄・語送り欄。利用者の指示「第 4 段を進めて」2026-10-14）
- D17: 継続した（EDTMSK の）SBCS 欄は、区間の並びを合成バッファへつないで `fieldEdit` の純関数を掛け、区間ごとに割り戻す（web-ui `editAcrossContinued` と同じ手順）。編集結果は `EditOutcome.also` で他の区間の値を運び、controller が `setField` する。Tab の停止点は並びの先頭区間だけ（`isTabStopField`）。
- D18: 語送り欄は空きを NUL で持ち、打鍵・Delete・Backspace のあとに `wordWrap` を掛ける。送る値は末尾の NUL を落とし、途中の NUL は `DEAD_MARK`（core が運ぶセンチネル）。`overlayField` は `DEAD_MARK` を空白の桁として描く。
- D19: 継続した語送り欄・J/E/G は引き続き「未対応」と知らせて値を変えない。
- D20: 継続した O 欄（鎖）は `oChainCells` の `chain*` を呼び、区間ごとのセルへ展開して割り戻す（web-ui `oChainApply` と同じ分担）。死んだ桁は `DEAD_MARK`、割れた全角は `splitLead`/`SPLIT_TAIL` で値に持ち、`overlayField` が同じ印をセルへ戻す。実機は未確認（偽のセッション）。

## 未確認（第 5 段）
- 継続欄・語送り欄とも偽のセッション（記録の画面の欄を書き換えたもの）でだけ確認した。実機（EDTMSK・WRDWRAP の画面）では未確認。
- 語送り欄の Field Exit（NUL 詰め）・継続欄の符号桁・満杯後の自動送りは web-ui との一致を試験していない。

## 実機確認（第 5 段。PUB400・利用者の指示 2026-10-14）
- テスト画面は `scripts/host-src/dscmd.c` に `CONTSB`（継続した SBCS 欄 3 区間）を足し、既存の `CONTOX`・`WRAPFLD` と一緒に利用者のライブラリへ `TTDSCMD` として作った（`CRTBNDC`。ホスト上の `/tmp/ttdscmd.c`・`/tmp/ttdscmd.log`）。
- 継続欄: `CONTSB` で `789` を打つ → Delete → Enter。ホストが受け取った欄は `f7 f8 f9 f5 f6`（`78`・`9`＋次の区間の `5`・`6`）で、区間をまたぐ打鍵と詰め直しが想定どおり。
- 語送り欄: `WRAPFLD` に `aaa bbbb cccc dddd` を打つ → 欄の中身は `81 81 81 40 82 82 82 82 40 00 00 83 83 83 83 40 84 84 84 84` で、ACS の記録（W1）と同じ。
- 継続した O 欄: `CONTOX` の最終桁 `X` を半角 `Q` に上書き → `0e …鎖… 0f d8 40 e8 e9`（`Q` が入り、後続の `YZ` は変わらない）。**全角の編集は未確認**——この接続の CCSID は SBCS で、DBCS のバイト列が文字に復号されない。
- **未解決の観察**: `WRAPFLD` の欄は (5,70) だが、ホストが読んだ欄の先頭アドレスは (5,63) で、ACS の記録（`11 05 47`）と違う。MCP 経由（端末を介さない）でも同じなので端末前面の起因ではない。web-ui・ACS の記録との差の理由は未調査。

## 未確認（第 1 段）
- 実機（IBM i）: 利用者の指示で PUB400 に接続し、サインオン・メニュー表示・数字入力・Enter での画面遷移を確認した（接続先・認証は記録しない）。挿入・Delete・全角入力の実機確認は第 3 段の分が未実施。
- Windows Terminal / VS Code 端末での表示は、利用者の判断（sodashitsu の端末版で表示できている）に依る。当 PJ では未実測。
- `4:4` の点線が出る端末・出ない端末（出ない端末では実線の下線に落ちる）。

## 未確認（第 3 段）
- O 欄の打鍵は、実機の記録が無いため偽のセッション（記録の画面の入力欄を O 欄に置換）で糊だけを確かめた。実機の DBCS 画面では未確認。
- 行をまたぐ欄の全角・O 欄、Field＋／Field−、継続欄の鎖の編集は未実装。
