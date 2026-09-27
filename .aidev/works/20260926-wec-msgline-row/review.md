# レビュー記録: 0x21 のメッセージを SOH のメッセージ行に重ねる

## タスク点検ログ
- [must][conv:-] T1 wtd-applier.ts / buffer.ts: `msgLineRow` が 24 固定で戻らず、27×132 と申告の無い画面で ACS（`processClearFMT` で画面の行数へ戻す）と食い違う / 対応: T1b（decisions D5）
- [should][conv:-] T1 wtd-applier.ts: 桁が不正な 0x22 だけ最下行に残り、桁の欠けた 0x22（メッセージ行）と分かれる / 対応: どちらもメッセージ行の 1 行全体（D4 に追記）
- [should][conv:paired-artifact-sync] T1 EmulatorPane.vue: `messageArea` の JSDoc が「0x22 のときだけ」のまま / 対応: 0x21 も書いた
- [nit][conv:-] T1 ScreenGrid.vue: `.opmsg-area` の CSS コメントが 0x22 だけ / 対応: 0x21 と切り捨て（D2）を書いた
- [should][conv:verify-by-mutation] T2 core test: 「90 字」のテスト名が core で固定できない性質（23 行へ続けない）を謳う / 対応: 名前を「本文は全部残し範囲は 1 行」に直し、web-ui に 90 字の幅 80ch のテストを足した
- [should][conv:-] T2 core test: 27×132 の期待値 24 が未確認の値の固定 / 対応: 原典で最下行と確かめ、27 に直した（D5）
- [should][conv:comment-provenance] T2 EmulatorPane.vue のコメント（T1 と同じ指摘）/ 対応: 同上
- [nit][conv:comment-provenance] T2 ScreenGrid.vue の CSS コメント（T1 と同じ指摘）/ 対応: 同上
- [nit][conv:-] T2 core test: 「範囲の外のセル」の名前が中身と合わない / 対応: 「メッセージ行も含めてセルには書かない」
- [nit][conv:comment-provenance] T2 web-ui test: 0x21 のテストが 0x22 の describe の下・出典に wec-msgline-row.txt が無い / 対応: describe を分け、出典を足した
- [should][conv:-] cross buffer.ts `clearSystemMessageIfTouched`: 寿命をいまの `msgLineRow` で見るため、D5 で行が最下行へ戻った後に表示位置とずれる / 対応: `systemMessageArea.row`（無ければ msgLineRow）で判定し、テストを足した（変異で落ちる）
- [nit][conv:-] cross wtd-applier.ts SOH（既存）: 長さが 0 か 8 以上でもフォーマットテーブルを消す（ACS は 0<len<8 だけ。それ以外は sense で打ち切り）/ 対応: この work の範囲外——backlog へ回す（deliver）

## ラウンド 1
- [should][conv:-] test-result.md:14 実機のライブラリ名がそのまま書かれている（AGENTS.md「実機の識別子」）/ 対応: `<AS400_LIB>` に置き換えた（前の work `20260926-window-error-code/test-result.md` の混入も同じく直した）
- [should][conv:comment-provenance!] packages/tn5250/src/screen/buffer.ts:819 寿命の判定の出典が D5 になっている（決定は D6）/ 対応: D6 に直した
- [nit][conv:paired-artifact-sync] packages/tn5250/src/screen/buffer.ts:798 `setHeaderData` のコメントがメッセージ行の用途を寿命だけとしている / 対応: 0x21 の位置と、直前の `clearFormatTable` で最下行に戻っていることを書いた
- [nit][conv:-] scripts/host-src/dscmd.c:328 `wecTest` の引数の順が `winErrTest` と逆 / 対応: `(int longMsg, int row22)` に揃えた

## ラウンド 2
- 前ラウンドの 4 件の解消を確認（識別子は `git grep` で 0 件、出典 D6、`setHeaderData` のコメント、引数の順）。このラウンドの差分に must/should は無い
