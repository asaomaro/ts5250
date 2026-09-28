# レビュー: WDSF 0x52

## タスク点検ログ
（指摘なし）

## ラウンド 1（独立レビュー・サブエージェント）
- [must][conv:-] packages/tn5250/src/screen/buffer.ts 「窓の並びの末尾」は ACS の `enpwindow` と違う（最後の窓を消すと ACS は null にし前の窓に戻さないが、当 PJ は残った古い窓の制限を外す） / 対応: 最後に作った窓を番号で持ち（`currentWindowId`）、その窓だけに掛ける。退避と復元で持ち回る
- [must][conv:-] packages/web-ui/src/components/EmulatorPane.vue:321 ペインは「制限つきの窓のうち最後のもの」に閉じ込める。ACS の `processCursorMoveInWindow` は `enpwindow` しか見ないので、2 つ目を解除すると ACS は閉じ込めないが当 PJ は 1 つ目に閉じ込める / 対応: 画面の写しに直近の窓の印（`current`）を出し、ペインはその窓だけを見る
- [should][conv:-] packages/tn5250/test/window-unrestrict.test.ts:44 上の食い違いを正しいものとして固定している。REMOVE WINDOW → 0x52 と閉じ込めの範囲の試験が無い / 対応: 足す
- [nit][conv:-] 退避と復元を挟んだ後の ACS の `enpwindow` は未確認 / 対応: 注記

## ラウンド 2
- 前ラウンドの 4 件の解消を確認（最後に作った窓を番号で持つ・画面の写しの `current`・ペインはその窓だけ・SOH の CSRINPONLY でも外す・REMOVE WINDOW と退避の試験・未確認の注記）。このラウンドの差分に must/should なし
