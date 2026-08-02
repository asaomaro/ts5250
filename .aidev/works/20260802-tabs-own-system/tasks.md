# タスク: タブがシステムを持つ

## 土台

- [x] T1: `paneLabels` にタブ ID の組み立て・分解（`makePaneTabId` / `splitPaneTabId` / ラベル引き）と `workspaceStore.systemOf(tab)`
- [x] T2: `PanePool` が `system` を配る（アプリ系ペイン 9 種に `system?: string` を宣言）（依存: T1）

## 束ね直し（宛先）— 1 種ずつ、送信内容のテストを付けてから次へ

- [x] T3: SQL（依存: T2）
- [x] T4: IFS（依存: T2）
- [x] T5: 一覧（ジョブ・オブジェクト・ユーザー）（依存: T2）
- [x] T6: スプール（依存: T2）
- [x] T7: データ待ち行列（依存: T2）
- [x] T8: データ転送（依存: T2）
- [x] T8b: アプリ系ペインに `systemsStore.selected` の参照が**残っていない**ことをテストで固定（依存: T3-T8）

## 並べられるようにする

- [x] T9: 開き直しで付け替えない（`assignSystem` 呼び出し撤去・(機能, システム) で開く/表示を判定）（依存: T8b）
- [x] T10: 絞り込み撤去（`visibleTabs` / `activeTabFor` / `lastActiveBySystem`）＋ `selected` → `menuSystem` 改名（依存: T9）

## 見分け（T10 と同じ PR に載せる）

- [x] T11: server — システム設定に `color`（スキーマ・`PublicSystem`・`publicSystem()` の白名簿）
- [x] T12: 設定 UI — `ConfigCard`（kind=system）に色の選択、`SystemForm`（依存: T11）
- [x] T13: `systemsStore.colorOf`（設定 ?? ref から自動）＋ `styles.css` にパレット（依存: T11）
- [x] T14: `SystemDot.vue` ＋ ヘッダーのパンくず・メニューへ点（依存: T13）
- [x] T15: `PaneTabs` の色帯とシステム名（2 システム以上のときだけ）（依存: T10, T13）

## 仕上げ

- [x] T16: メニューの対象（フォーカス中タブに追従・**開いた時点で固定**・作成ボタンの文言）（依存: T10）
- [x] T17: 消えたシステムの銘板（`PanePool` が出す）＋ 共通文言（依存: T2）
- [x] T18: 破壊的な操作の確認文言に対象システム名（依存: T15）
- [x] T19: build / lint / web-ui スイート（依存: T16-T18）
- [x] T20: 実機で実ブラウザ検証（A と B を並べ、**それぞれが自分のシステムの結果**を出す）＋ `scripts/README.md`（依存: T19）
