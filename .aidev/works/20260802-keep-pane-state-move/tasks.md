# タスク: 最大化・タブ移動でも状態を維持する

- [x] T1: `composables/openedPanes.ts` — 「一度でも開いたアプリ系タブ」の共有記録
- [x] T2: `stores/workspace.ts` — `groupOf(tab)` 追加・`displayRoot()` 削除
- [x] T3: `components/PanePool.vue` — 実体＋Teleport
- [x] T4: `WorkspaceNode.vue` — 受け皿だけを描く
- [x] T5: `WorkspaceNode.vue` — 分割段で最大化を表現
- [x] T6: `App.vue` — `root` を描き `<PanePool>` を置く
- [x] T7: テスト更新・追加（`pane-state-keep` を App ベースへ／`pane-maximize` の不変条件を書き換え）
- [x] T8: build / lint / web-ui スイート
- [x] T9: 実機で実ブラウザ検証（分割・最大化・タブ移動の寸法と保持）＋ `scripts/README.md`
