# タスク: タブグループ

- [x] T1: 色パレットを足す。`styles.css` に `--tg-1`…`--tg-8`（ライト／ダーク）、
      `composables/tabGroupColor.ts` に `TAB_GROUP_COLOR_COUNT` / `tabGroupColorVar` / `nextTabGroupColor`
      （`systemColor.ts` の方針を踏襲：番号だけ持つ・赤黄を避ける・ダークは明度のみ）
- [x] T2: ストアにモデルと正規化を入れる（依存: なし）。`TabGroup` 型・`tabGroups` / `tabGroupOf` /
      `draggingTabGroup`、`normalizeTabGroups()`（迷子の掃除 → メンバー ≤1 で解除 → 参照なし定義の削除 →
      連続化）。既存の `dropTabInto` / `moveTab` / `split` / `closeSession` から呼ぶ
- [x] T3: グループ操作を足す（依存: T2）。`groupTabs` / `ungroupTabGroup` / `renameTabGroup` /
      `setTabGroupColor` / `tabGroupOfTab` / `tabGroupTabs`、および `dropTabInto` の
      「着地点の両隣」による所属判定（同じグループに挟まれたら参加・それ以外は離脱）
- [x] T4: 折りたたみを足す（依存: T2）。`toggleTabGroupCollapsed` と `visibleTabs` の絞り込み。
      **`tabs` と `activeTab` には触らない**（`pane-state-keep.test.ts` が緑のままであること）
- [x] T5: グループごとの移動を足す（依存: T2）。`moveTabGroupInto`（別ペインへ合流）と
      `splitWithTabGroup`（ペイン分割。`narrow` / 最大化中は合流へフォールバック）
- [x] T6: `dnd.ts` に `TAB_MIME` / `TAB_GROUP_MIME` 定数と `isTabGroupDrag` を足す（依存: なし）
- [x] T7: `PaneTabs` の描画（依存: T1, T3, T4）。`StripItem`（チップ＋タブの一列）・チップ（色・名前・
      `∨`／`›`・アクティブの印）・メンバータブの背景と `box-shadow: inset` の下線・端の丸め。
      **border / padding / outline を足さない**（高さ不変）
- [x] T8: `PaneTabs` の D&D（依存: T6, T7）。`zoneOfTab`（`edge = width * 0.3`・非厳密比較）・
      `center` で `groupTabs`・`.drop-into` の予告・チップの `dragstart`／グループのドロップ受け・
      畳んだチップへのドロップで参加（畳んだまま）
- [x] T9: `WorkspaceNode` の端 4 ゾーンでグループのドロップを受ける（依存: T5, T8）。
      `TAB_GROUP_MIME` を先に読み、あれば `splitWithTabGroup`。`isFileDrag` の既存分岐は維持
- [x] T10: `TabGroupMenu.vue` を作る（依存: T5, T7）。名前入力・色 8 個・グループ化を解除・
      グループ内のタブをすべて閉じる（`window.confirm`＋`opMessages` の定数）。
      `PaneTabs` の `infoFor` を `openPopover`（info / tabgroup の排他）へ置き換える
- [x] T11: 既存タブを前面に出す経路で自動展開する（依存: T4）。~~`LauncherPane.vue` /
      `composables/openConfigured.ts` が折りたたみ中のタブを指名したら~~ → **同じ形が 4 か所あったため
      `setActiveTab` 1 か所へ集約**（`decisions.md` D1）。呼び出し側は無変更
- [x] T12: テストと型検査（依存: T9, T10, T11）。`test/tab-groups.test.ts` と
      `test/tab-group-ui.test.ts` を追加し、`cd packages/web-ui && npx vitest run` を全通し、
      `npm run build -w @ts5250/web-ui` で型検査（root の build では web-ui を見ない）
