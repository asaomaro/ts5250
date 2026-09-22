# レビュー: WSF D9/72 への応答

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目 9 の独立点検。`scratchpad/review-milestone9.md`）
- [should][conv:-] packages/tn5250/src/protocol/wtd-applier.ts:946 ACS は 1 つの WSF で最初の SF だけを処理して次に ESC を求め、応答は WSF ごとにその場で送る。当 PJ は SF を全部読み、応答も Query と D9/72 のどちらか 1 本で、D9/72 の応答の後は同じレコードの READ も読まなかった / 対応: 最初の SF だけを読む（長さの分だけ進める）・応答を起きた順の一覧（`wsfReplies`）にして全部送る・WSF だけのレコードでなければ READ まで処理する。Query はフラグが 0 のときだけ応答（ACS と同じ）
- [nit][conv:-] packages/tn5250/src/protocol/query-reply.ts:104 「ACS とバイト単位で同じ」はデータ部だけ（ACS はレコード長に `FF EF` まで数える） / 対応: 主張をデータ部に絞り、差を書いた
- [nit][conv:-] decisions D2「フラグ 0x80 は返さない」が否定応答を入れた後も残っていた / 対応: 取り消し線で破棄を記録

## ラウンド 3（通過）
- ラウンド 2 を直し、SF 2 つ・WSF 2 つ・D9/72＋READ・短い WSF をテストで固定した。社内機の DSM で WSF72・WSF72N の応答をホストが ACS と同じに読んだ。指摘なし。

## ラウンド 4（節目 10 の独立点検。`scratchpad/review-milestone10.md`）
- [nit] SF が 4 バイトで終わる WSF（`00 04 D9 70`）は、ACS が範囲外を 0 と読んで Query に応答するのに、当 PJ は応答しない（`applyStructuredField` の `sf[4]` が undefined）/ 対応: 実在しない形（未確認）として台帳へ。同じ点検の記録の同期漏れのうち、この work の design.md（`ApplyResult.wsfD972` → `wsfReplies`）は取り消し線つきで直した（件数は `20260921-negative-responses` に数えた）

## ラウンド 5（通過）
- 節目 10 の指摘（nit 1）を台帳に残し、design.md の古い記述を直した。コードの変更は無い。指摘なし。
