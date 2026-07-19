# 計画: 接続設定の分離（システム / セッション設定）

## 実装方針

design.md の依存順（config core → サーバー消費者 → Web UI）に沿って、**3 つの subtask** に割る。

### split 判定

`aidev-docs/DESIGN.md`「5.」の決定木に照らした判断:

- **単独でデリバリ可能か** → **不可**。config core だけ入れても誰も使えず、サーバーだけ変えると
  Web UI が壊れる。振る舞いを変えない refactor ではなく、データモデルの置換なので途中状態で成立しない
- **高結合かつ大規模で漸進レビューの価値があるか** → **ある**。新規モジュール 4 本、プロトコル 3 系統、
  UI の再構成、移行処理。1 本の PR にすると 2,000 行規模になり、信頼境界の確認が埋もれる
- → **subtask 分割**を採る

**分けない案**（単一 tasks.md + walkthrough）も検討したが、信頼境界の 5 層確認と移行規則の検証が
UI の差分に埋もれるのを避けたい。境界に関わる変更は独立してレビューされるべき。

### 割れ目（seam）と、その根拠

| subtask | 範囲 | 単独で検証できるもの | 親に委ねるもの |
|---|---|---|---|
| `10-config-core` | `config-types` / `config-migrate` / `config-store` / `config-resolver` | 移行規則（純関数・実データの期待結果）、スキーマ 2 本立て、所有者チェック | 実機接続 |
| `20-server-surfaces` | `ws-handler` / `ws-messages` / `mcp-tools` / `host-lists` / REST / verify スクリプト / ドキュメント | 既存サーバーテスト、`verify-mcp` / `verify-ws`、実機の 5250・プリンター・一覧 | ブラウザ経路 |
| `30-web-ui` | `stores/systems` / `LauncherPane` / `ConfigCard` / `PaneTabs` / `App.vue` / `HostListPane` | ブラウザでの操作（ランチャー・その場編集・タブのフィルタ） | 全経路の通し |

**producer → consumer の順序**: 10 が型と解決点を提供し、20 がそれを 3 系統に配線し、
30 が 20 の API を使う。逆向きの依存は作らない。

## 作業順序と依存関係

```mermaid
flowchart LR
  A["10-config-core<br/>型・移行・ストア・解決点"] --> B["20-server-surfaces<br/>WS / MCP / REST・スクリプト・docs"]
  B --> C["30-web-ui<br/>ランチャー・その場編集・タブ"]
  C --> D["親: 統合 test / review<br/>実機 4 経路 + 信頼境界 5 層"]
```

1. `10-config-core`（依存: なし）
2. `20-server-surfaces`（依存: 10）
3. `30-web-ui`（依存: 20）
4. 親の統合 test / review（依存: 全 subtask）

## リスク / 留意点

- **信頼境界の 5 層**（research F5）が最大のリスク。`autoPdfDir` はサーバー上の任意パスへの
  ファイル書き込みに直結する（`printer-output.ts:71` が設定値をそのまま `join` に渡す）。
  1 層目（個人セッションスキーマに `printer` を持たせない）は `10` で、
  5 層目（サーバー設定由来のときのみ適用）は `20` で確認する
- **移行の誤結合**（spec B2 規則 3）。同一 host に別ユーザーの設定がある環境で誤ったシステムに
  繋がないこと。`10` の単体テストで、規則 1/2/3 それぞれのケースを固定する
- **3 系統の同時変更**。`20` の中で MCP / WS / REST を分けない。分けると命名が食い違い、
  `verify-mcp.mjs` / `verify-ws.mjs` が壊れたまま残る
- **`20` の完了時点で Web UI が壊れる**。これは想定内（`30` で追従）。ただし親の統合 test まで
  ブラウザ経路は検証できないため、`20` の test では「壊れている」ことを明示的に記録する
- **実機（PUB400）依存**の検証は `20` と親に集中する。CI では skip されるので、
  skip 件数を test のサマリに残して deliver へ引き継ぐ

## テスト方針

| 層 | 方法 |
|---|---|
| 移行規則 | 単体テスト。**実データの期待結果**（1 システム + 3 セッション、`pub400-printer` が規則 2 で吸収）を固定 |
| スキーマ 2 本立て | 個人設定に `printer` を送ると 400 になることをテスト |
| 解決点 | `session` のみ / `system` のみ / 両方一致 / 両方不一致 / 該当なし の 5 ケース |
| 所有者・権限 | 既存の `profiles-admin-only.test.ts` 相当を新モデルへ |
| MCP | `mcp-list-connections.test.ts` を新モデルへ（全 7 ケース） |
| E2E スクリプト | `verify-mcp.mjs` / `verify-ws.mjs` |
| 実機 | 5250 / プリンター / 一覧 / SQL の 4 経路（PUB400） |
| 信頼境界 | 5 層それぞれに独立した確認を持たせる |
| ブラウザ | ランチャー・その場編集・タブのフィルタ（切り替えで閉じないこと） |
