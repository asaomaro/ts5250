# レビュー: 否定応答

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [should][conv:-] packages/tn5250/src/protocol/wtd-applier.ts:217 「ESC が無い→0x10050121」を全オペコードに当てていた。ACS はオペコードで違う（NOOP・CANCEL INVITE・メッセージ灯はデータを読まない、OUTPUT ONLY・RESTORE は最初の 0x04 まで読み飛ばす、知らないオペコードは 0x10030101） / 対応: `session.ts` の `streamOf` で ACS `processPassthru` と同じに振り分ける
- [should][conv:-] packages/tn5250/src/session/session.ts:797 否定応答を Query 等の応答より前に送っていた（D3 は構造の都合だけ） / 対応: 応答を送ってから最後に否定応答（`sendNegative`。早期 return もすべて通す）。D3 を破棄
- [should][conv:-] packages/tn5250/test/wtd-applier.test.ts:298 「レコードの残りは読まない」が ROLL・CUA・WSF 0x80 で固定されていなかった（test-result の「mutation 7 通り検出」は言い過ぎ） / 対応: 否定応答の後ろに WTD と READ を置いたテストを足し、`return finish()` を外す変異で落ちることを確かめた
- [nit][conv:-] ESC が無い・CUA・ROLL で ACS は CC2 と SAVE PARTIAL の応答を飛ばす / 対応: 見送り（当 PJ は READ でも解錠するので CC2 だけ落としても ACS と同じにならない。DSM で測ってから直す項目として台帳へ）
- [nit][conv:-] 否定応答を入れた後も以前の主張が取り消し線無しで残っていた（`wtd-applier.ts:162`・`buffer.ts:701`・`wsf-d9-72` D2・`acs-parity.md:542`・`datastream-commands.md:157・164-166`） / 対応: 取り消し線で残し、事実を書き直した

## ラウンド 3（通過）
- ラウンド 2 の should 3 件を直し、nit 2 件を直す／台帳へ送った。社内機の DSM（WSF72・WSF72N・WSF72X・ROLLBAD・BADCMD）で以前と同じ結果、通常の画面を社内機と PUB400 で一巡させて偽の否定応答 0 件。指摘なし。
