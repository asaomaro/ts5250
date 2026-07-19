# タスク

- [x] **T1** `packages/server/src/host-api.ts` を新規作成し、`host-lists.ts` から
      `sourceSchema` / `resolveSource` / `statusOf` / `compact` を切り出して共有する
      （3 箇所目が出たので切り出す。前作業 review の nit「3 箇所目が出たら切り出す」に該当）
- [x] **T2** `packages/server/src/host-sql.ts`（`POST /api/host/sql`）。`openDb` で単発完結、
      `maxRows` 上限 1000 をサーバー側で強制、`SqlError` の `sqlCode`/`sqlState` を本文に載せる。
      **D1 の依存条件（query が SELECT しか実行できないことに依存）をコメントに明記**
- [x] **T3** `app.ts` にルート登録
- [x] **T4** `packages/web-ui/src/components/SqlPane.vue`（入力・実行・結果表・エラー・CSV）
- [x] **T5** CSV 生成（UTF-8 BOM ＋ CRLF ＋ RFC 4180）。純関数に切り出してテスト可能にする
- [x] **T6** 配線 4 箇所: `paneLabels.ts` / `WorkspaceNode.vue` / `PaneTabs.vue` の `isPane` /
      `App.vue` の `activeIsEmulator` / `LauncherPane.vue` の `FEATURES`
- [x] **T7** server テスト（入力検証・上限強制・資格情報欠落・認可）
- [x] **T8** web-ui コンポーネントテスト（`host-list-pane.test.ts` を雛形に。
      fetch モック・ストアの後始末・CSV の中身）
- [x] **T9** `tsc -b` / `npm run build -w @as400web/web-ui`（vue-tsc）/ lint / 全テスト
- [x] **T10** **実ブラウザで確認**（表示・CSV・テーマ追従・タブを閉じる動作）
- [x] **T11** README 追記 ／ `decisions.md` 転記
