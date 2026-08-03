# レビュー記録: 03-ui

## ラウンド 1（2026-08-02）

差分: `planApi.ts` / `planStore.ts` / `planLayout.ts` / `PlanGraph.vue` / `PlanViewer.vue` /
`PlanListPane.vue` の追加、`SqlPane.vue` / `opMessages.ts` / `paneLabels.ts` / `PanePool.vue` /
`LauncherPane.vue` の変更、テスト 5 本。

### 指摘

- **[should]** `planStore.ts` — **localStorage への書き込み失敗を握り潰していた。**
  計画は属性まで持つと 1 件で数十 KB になり、上限 20 件 × 2 種で容量に届きうる。
  書けなかったのに「保存しました」と出すと、**次に開いたとき黙って消えている**。
  **対応: 修正済み。** `write` が成否を返すようにし、`savePlan` / `pushHistory` が `persisted` を返す。
  `PlanListPane` は書けなかったときに理由（`MSG_PLAN_SAVE_NOT_PERSISTED`）を出す。
  回帰テスト 2 件を追加（jsdom の `Storage` はインスタンスへの代入が効かないので prototype を差し替える）。

- **[nit]** `PlanGraph.vue` に実在しない CSS プロパティ `stroke-left` が残っていた。
  **対応: 削除済み**（種別は枠線の色と破線で分ける）。

- **[nit]** `PlanListPane` の「この計画を保存」は、履歴から開いた計画を再度保存すると重複する。
  **現状維持**——利用者が「これを残す」と明示した操作なので、重複を機械的に弾くと
  「名前を変えて 2 つ残す」ができなくなる。

### 計画から変えた判断（`test-result.md` にも記載）

**`no-rows` ボタンを文種で塞ぐのをやめた。** 当初計画は「非クエリ文では出さない」だったが、
実装時に 3 つの理由で取りやめた:

1. 判定（`isNonQueryStatement`）は hostserver 側の純関数で、web-ui に写すと**同じ判定が 2 か所**になる。
   `db-decode.ts` の CCSID 判定がまさにそれで事故った前例がコメントに残っている。
2. `@ts5250/hostserver` を web-ui から実行時 import すると**バンドルにホストサーバー実装が入る**
   （AGENTS.md「パッケージ分割と入口」）。
3. `docs/UI-DESIGN.md` /（AGENTS.md「UI デザインガイド」）に
   **「環境の検出結果で選択肢を塞がない。印を出すに留め、選ばせて結果で分からせる」**とある。

→ 両方のボタンを出し、サーバーが「行を返さずに計画だけ取るモードは SELECT 系の文でのみ使えます」と
明示して断る。**塞ぎ過ぎと判定の重複を同時に避けられる。**

### 規約の確認

| 観点 | 結果 |
|---|---|
| **依存を足していない** | `package.json` は無変更（グラフは自前 SVG） |
| 配色は CSS 変数 | `var(--card)` / `var(--line)` / `var(--accent)` / `var(--sys-1)` 等。**生色なし** |
| 文言は `opMessages.ts` に集約 | 7 定数を追加。テストは**定数を参照**している |
| **「実行しない」と書かない** | ボタン・`title`・ビューアの表示すべて。テストで固定 |
| ペイン登録の型安全 | `PANE_PREFIXES` に足したので `PanePool` の `Record` が型で強制（足し忘れ防止の仕掛けに乗った） |
| `vue-tsc` を通す | `npm run build` で通過（`exactOptionalPropertyTypes` の指摘も解消） |
| 秘密の扱い | 計画の文テキストをサーバーへ送り返さない。保存は明示操作のみ |
| 既存の非退行 | 3,758 件緑。`SqlPane` は**結果表を置き換えず**別パネルに出す（テストで固定） |

### 判定

**should 1 件を修正**、nit 1 件修正・1 件は理由を添えて現状維持。**この subtask としては通過**。
