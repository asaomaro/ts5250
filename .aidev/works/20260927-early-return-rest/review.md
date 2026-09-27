# レビュー記録: その場で戻る否定応答の残り

## タスク点検ログ（T1〜T3 と review を兼ねた点検）
- [should][conv:-] T1 READ の CC1 は原典の読みだけ / 対応: research F1・コメントに「CC1 は未実測」と書いた
- [nit][conv:-] T1 引数の無い CUA が読むのは 0（`clearSaveBuff`）/ 対応: コメントを直した
- [nit][conv:-] T1 earlyReturn の範囲は ACS と一致（確認）/ 対応: なし
- [should][conv:-] T2 持ち越しを配列で積む（ACS は 1 つの置き場）/ 対応: 1 つにし、次の SAVE PARTIAL で上書き（D4。テスト）
- [nit][conv:-] T2 コマンドを読まないレコードで送る / 対応: データの無いレコードでは送らない（テスト）
- [nit][conv:-] T2 ホストのエラーの保留との組み合わせ・繋ぎ直しで捨てる・自分の SAVE PARTIAL を尾部より前に送る（既存）/ 対応: 未確認・当 PJ の決めとして記録
- [should][conv:verify-by-mutation!] T3 連続してその場で戻る・上書きのテストが無い / 対応: 足した（変異で落ちる）
- [should][conv:-] T3 research F4「警報は 2 回」は条件つき / 対応: 直した（D1 も）
- [nit][conv:-] T3 verify の否定応答の見分け / 対応: 固定の位置で見る
- [nit][conv:-] T3 dscmd.c に CC1 のモードが無い / 対応: 未実測として記録

## ラウンド 1（review）
- 上の点検と同じ指摘（should 4・nit 3）/ 対応: 上のとおり

## ラウンド 2
- 解消を確認（tn5250 1014 件・新しいテスト 8 件）。must/should は無い
