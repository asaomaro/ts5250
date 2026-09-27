# レビュー記録: その場で戻る否定応答と CC2

## タスク点検ログ
- [should][conv:-] T1 wtd-applier.ts abortRecord: SAVE PARTIAL は ACS でそれまでの CC2 をその場で効かせるのに、無条件に落としていた / 対応: `committedCc2` まで戻す。テストを足した（変異で落ちる）
- [nit][conv:-] T1 コメントの「WTD / READ の CC2」: ACS の READ の CC2 は溜めない（`lastReadCCbyte2`）/ 対応: 「WTD の CC2」に直した。READ の CC2 を当 PJ が常に効かせる差は既存——backlog
- [nit][conv:-] T1 unlockKeyboard を戻していない / 対応: 読む箇所が無いので戻さない旨をコメント
- [should][conv:-] T2 ESC が無いテストを READ で試していた（ACS の仕組みと対応しない）/ 対応: WTD＋CLEAR FORMAT TABLE＋不正なバイトに替えた
- [should][conv:-] T3 verify-early-return-cc2.mjs の前提コメントが実装と違う（READ MDT）/ 対応: 直した
- [nit][conv:-] T3 dscmd.c: 出力の戻りは CPFA303 / 対応: 直した
- [nit][conv:-] T3 dscmd.c: QsnCrtCmdBuf の失敗を見ていない・unsigned char に揃っていない / 対応: 直した
- [nit][conv:paired-artifact-sync] T3 scripts/README.md の dump の説明が古い / 対応: mw= ほかを足した

## ラウンド 1
- [should][conv:measurement-sanity] dscmd.c: 実測の後に直した EARLYROLL を実機でコンパイル・実行していない / 対応: build-dscmd で作り直し（CZS1607）、verify pass=4 を再現してから片付けた
- [nit][conv:-] dscmd.c: QsnCrtCmdBuf の失敗でログを閉じずに戻る / 対応: 閉じてから戻す
- [nit][conv:paired-artifact-sync] design.md の対象範囲に scripts/README.md が無い / 対応: 足した
- [nit][conv:-] early-return-cc2.test.ts: SAVE PARTIAL の形が 1 つだけ / 対応: 「前で消し後ろで点ける」「SAVE PARTIAL 2 つ」を足した
- [nit][conv:-] early-return-cc2.txt: 行末の空白 / 対応: 消した
- [nit][conv:-] wtd-applier.ts: SAVE PARTIAL の前の警報は ACS では 2 回鳴る（`pendingCCbyte2` を捨てない）/ 対応: 範囲外——backlog に残す

## ラウンド 2
- 前ラウンドの 6 件の解消を確認（テスト 11 件が緑・実機 pass=4）。このラウンドの差分に must/should は無い
