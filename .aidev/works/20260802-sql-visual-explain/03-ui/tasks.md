# タスク: 03-ui

- [x] T1: `planApi.ts` — REST の呼び出しと画面側の型（`QueryPlan` はサーバーの型に合わせる）
- [x] T2: `planStore.ts` — 実行履歴・保存（localStorage・上限 20 件）・JSON 入出力・比較の差分計算
- [x] T3: `PlanGraph.vue` ＋ `planLayout.ts`（**座標計算は純関数に切る**）。自前 SVG（依存を足さない）
- [x] T4: `PlanViewer.vue` — グラフ／ツリー切替・ノード属性・索引助言（`CREATE INDEX` の確認実行）・
      未対応の記録種別の表示・比較（依存: T1, T2, T3）
- [x] T5: `PlanListPane.vue` — ソース切替（プランキャッシュ／実行履歴）。
      **`available:false` は理由を出して無効化**し、履歴側へ切り替えられる（依存: T2, T4）
- [x] T6: `SqlPane.vue` に「計画」の導線（`実行して計画` / `行を返さず計画`）と計画タブ（依存: T4）
- [x] T7: ペインの登録（`paneLabels.ts` の `PANE_PREFIXES` ＋ `PanePool.vue` ＋ `LauncherPane.vue`）
      と文言の集約（`opMessages.ts`）（依存: T5）
- [x] T8: テスト（依存: T2, T3, T4, T5, T6）
- [x] T9: `npm run build`（`vue-tsc` 込み）/ `npm run lint` / `npm test` を通す（依存: T7, T8）
