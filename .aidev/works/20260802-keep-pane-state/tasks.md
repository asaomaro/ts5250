# タスク: 開いたタブは閉じるまで生かす

- [x] T1: アプリ系ペイン 9 種に `active?: boolean` を宣言
- [x] T2: `WatchPane` — 既読は見えている間だけ
- [x] T3: `ServicesPane` — 定期取得は見えている間だけ
- [x] T4: `WorkspaceNode` — 接頭辞→ペインの表・遅延マウント・`v-show`
- [x] T5: `App.vue` — ペイン移動のフォーカス先から隠れた要素を除く
- [x] T6: 回帰テスト `test/pane-state-keep.test.ts` ＋ `watch-console` に隠れている間の未読
- [x] T7: build / lint / web-ui スイート
- [x] T8: `App.vue` — メニュー・システム切替でもワークスペースを外さない（追加指示）
- [x] T9: `IfsPane` — 再読み込みボタン（追加指示。自動で取り直さなくなったぶんの入口）
- [x] T10: 実機で実ブラウザ検証 `scripts/verify-pane-state.mjs` ＋ `scripts/README.md`
