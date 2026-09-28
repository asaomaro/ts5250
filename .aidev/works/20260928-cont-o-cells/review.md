# レビュー: 継続欄の O の編集

## タスク点検ログ
（委譲の独立点検 1 回で全タスクと横断を見た。指摘はその場で直した）
- [must][conv:-] packages/web-ui/src/components/ScreenGrid.vue DBCS の Delete / 選択がある Delete で `deleteSelection` を 2 回呼び、縮んだ値に同じ範囲をもう一度当てていた / 対応: 1 回だけ呼ぶ（`hadSelection`）。テスト「選択して Delete は選択だけを消す」・mutation 検出
- [should][conv:-] ScreenGrid.vue `commitIntoChain` / 上書きで鎖の終わりに着いた IME の余りを黙って捨てていた / 対応: 満杯なら次の欄へ送り余りを流す（`flowToNextField`）。テスト・mutation 検出（break を外す変異は等価）
- [should][conv:-] packages/web-ui/src/composables/oChainCells.ts `reflow` / 前半が区間の最後の桁に来る場合を守っていなかった（字が消える） / 対応: 実機の ACS で測った（`scripts/acs-probe/cont-o-last-lead.txt`: ACS は前半・後半を区間の間で割り、並びを閉じない。画面は崩れるがホストのバイト列は `…4488 4481 4484 0f…`）。当 PJ の値では 1 字を割って持てないので 0012（既知の差。台帳 (e)）
- [should][conv:-] ScreenGrid.vue `syncDbcs` / 継続した O 欄にも `normalizeO` が掛かり、区間をまたぐ並びをカーソルの移動だけで組み直して MDT を立てうる / 対応: 継続した O 欄は字を置いた・消した回だけ。テスト・mutation 検出
- [nit][conv:-] ScreenGrid.vue `dbcsSelection`・`openDtFor` / 死んだ桁の印がクリップボード・日付の値に混ざる / 対応: `isDeadMark` も外す
- [nit][conv:-] oChainCells.ts の SI SO の取り除き / 取り除いた後に見直さない / 対応: 1 つ戻って見直す。テスト・mutation 検出
- [nit][conv:-] packages/tn5250/src/screen/buffer.ts `setFieldValue` / 死んだ桁の印の振り分けを継続していない O 欄にも掛けていた / 対応: 継続欄に限る
- [nit][conv:-] 単独の SO/SI の Delete（0065）の詰め直し・編集の値が消えた後の死んだ桁・最終区間へ詰めたときの READ INPUT の末尾 / 対応: 未測定として decisions D5・D1・台帳に残す（変更なし）

## ラウンド 1
- 指摘なし（タスク点検で直した分は上。要件適合: AC1〜AC7 を満たす。価値適合: 実機のブラウザでホストのバイト列とカーソルが ACS と 12 巡一致。規約: 原典の事実のみ・実識別子なし・後片付け済み）
