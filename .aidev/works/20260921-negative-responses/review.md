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

## ラウンド 4（節目 10 の独立点検。`scratchpad/review-milestone10.md`）
- [should][conv:-] packages/tn5250/src/session/session.ts:847 WSF の応答があるレコードで、同じレコードの READ SCREEN・READ IMMEDIATE・READ MDT IMMEDIATE ALT・READ SCREEN EXTENDED の応答が落ち（応答を 1 つ送って戻っていた）、ホストが待ち続ける / 対応: 応答は全部送り（SAVE → WSF → READ SCREEN EXTENDED → READ IMMEDIATE → READ MDT IMMEDIATE ALT → READ SCREEN）、否定応答は最後に 1 回。画面を書いたレコードは画面イベントも出す（`ScreenBuffer.wroteInThisRecord`）。コマンド順でなく固定順で送る差は台帳に残した（未確認）。テスト `negative-response-order.test.ts`
- [should][conv:verify-by-mutation!] 「mutation でどれも落ちる」は選んだ 29 通りに限って正しかった。CANCEL INVITE・メッセージ灯 OFF・RESTORE SCREEN・ESC 無しの分岐・オペコード上限の境界・未知オペコードの return・SF のクラス D9・WSF の最短長・Tab の送り先の保護欄が生き残っていた / 対応: 固定するテストを足し、点検役の変異を当て直した（test-result）
- [should][conv:-] docs/PROTOCOL.md:98 ほか、記録の同期漏れ（取り消し線なしで古い主張が残った: 全 opcode でデータを処理する・design の否定応答の順・`senseCode` の doc・台帳）/ 対応: 取り消し線で残して事実に直した
- [should][conv:-] `processPassthru` のオペコード固有の動作（opcode 1・3・6・7・9）が未実装なのに台帳に無い / 対応: 台帳 `acs-parity.md` の「節目 10 の独立点検で確かめられなかった懸念・残した差」に記録
- [nit] 末尾の ESC 1 バイトだけのレコードは例外で握りつぶされる（ACS は未知のコマンドとして続ける） / 対応: 台帳へ（実在しない形。未確認）
- [nit] 退避の応答が WSF の応答より常に先（ACS はコマンド順） / 対応: `wsfReplies` の doc を「起きた順は WSF 同士」とし、台帳へ

## ラウンド 5（通過）
- 節目 10 の指摘を直した。テストを足し、点検役の変異 33 通りを当て直して 32 通りが落ちた（残る 1 通りは、直した後にコードが無くなった）。応答連鎖の新しい分岐 9 通りは、初回に 3 通りが生き残ったのでテストを足して 9 通りとも落ちた。記録の古い主張は取り消し線で直した。指摘なし。
- 変更規模の割り当て（目安）: 前回の累計に、今回の差分〔`session.ts`・`buffer.ts`・`wtd-applier.ts`・テスト・`docs/PROTOCOL.md`〕を足した。`docs/PROTOCOL.md` だけ、この work が新しく触れたファイルとして数えた
