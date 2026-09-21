# レビュー: 表示セッションの開始の知らせ

## タスク点検ログ
- T1・T2・cross: 同じセッションで差分を読み直した。指摘なし（「先に出ている通知を上書きしない」のテストの抜けは test 工程の mutation で見つけて足した）。

## ラウンド 1（同じセッション。節目の独立点検はマイルストーン 10 で）
- 要件適合: `aidev coverage` は tasks 承認時と同じ（ac=5・gaps=0）。
- 価値適合: 繋がったとき・繋ぎ直したときに起動応答のコードが見え、I901（関連付けたプリンターが無い等）に気づける。ⓘ でも確かめられる。
- 正確性: 3 秒で消すのは同じ文言がまだ出ているときだけ。先に出ている通知は上書きしない。3270・VT は起動応答が無いので出ない。
- 規約適合: 文言は `opMessages.ts` に 1 か所・ACS の文言は写していない。
- 指摘なし。

## ラウンド 2（節目 10 の独立点検。`scratchpad/review-milestone10.md`）
- [should][conv:-] packages/web-ui/src/composables/opMessages.ts:356 開始の知らせが I901・I902 以外のコードで ACS と違う（I906 は実際に届く）。ブラウザの繋ぎ直し・後から入るタブでも、ホストへは繋ぎ直していないのに「開始しました」と出る / 対応: I901・I902 以外は「応答コード: <コード>」（`AcsOnly.displayResponseCode` の else 側）、知らせるのはホストへ繋がったときだけ（`noteStartup` の `announce`）。I906 などの扱いの残りは台帳へ。テスト `startup-code-notice.test.ts`・`session-reconnect.test.ts`
- [nit] ACS は状態行の文言を履歴に残す。3 秒で消えた知らせは、当 PJ では ⓘ のコード以外に残らない / 対応: 台帳へ

## ラウンド 3（通過）
- 節目 10 の指摘を直した。変異 5 通り（I901・I902 の分岐・`announce` の有無・ブラウザの繋ぎ直し・ホストへ繋ぎ直せたとき・自分で開いたとき）が落ちる。指摘なし。
- 変更規模の割り当て（目安）: `opMessages.ts`・`session-controller.ts` の関連付けなしで開いた理由の知らせ（`MSG_ASSOC_PRINTER_ISSUE`）は、この work に数えた（`20260921-associated-printer-session` の分）
