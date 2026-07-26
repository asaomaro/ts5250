# タスク: 相方を失った DBCS セルを 1 桁で描く

- [x] T1: `ScreenGrid.vue` に述語 `hasTail(row, i)` / `hasLead(row, i)` を置く（隣の桁の kind だけで判定・状態を持たない）
- [x] T2: 回帰テスト `packages/web-ui/test/screen-grid-dbcs-orphan.test.ts` を先に書き、**現状で落ちること**を確認する
- [x] T3: セグメント組み立てに孤児 lead（1 桁クリップ）／孤児 tail（空白 1 桁）の分岐を足す（依存: T1）
- [x] T4: `half` セグメントの描画と `.half-cell` の CSS（`width:1ch` / `overflow:hidden`）を足す（依存: T3）
- [x] T5: `localSpans` の「表示文字を持つ桁」判定を述語と揃える（孤児 tail を 1 文字として数える）（依存: T1）
- [x] T6: T2 が通ることと、既存の web-ui テスト全通過・`vue-tsc` 込みビルドを確認（依存: T3, T4, T5）
- [x] T7: 実機（）の Attn 窓で修正前後を撮り、背面 19 行目が ACS と同じ桁位置になることを確認（依存: T6）
