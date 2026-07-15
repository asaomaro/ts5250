# 統合レビュー: 20260714-5250-mcp-web-emulator

全 subtask（01–07）完了後の**親統合 review**。結合起因の欠陥（契約整合・結線・統合 test 通過）を重点に点検。

## ラウンド 1（2026-07-15）

### 結合観点の点検

- **型フローの一貫性（core→server→web）**:
  - `ScreenSnapshot`（`gui` 含む）を単一の画面表現として core が定義・export し、server（format/mcp-tools）と
    web（ScreenGrid）が type-only で消費。GUI 型（GuiConstructs/GuiSelectionField/…）も core 一元 export。
  - `ConnectOptions.enhanced` が全接続経路に結線: MCP `open_session`＋`buildDirectOpts`、`profiles`、
    WS `open`（WsOpen＋buildDirect）→ `OpenOptions`(extends ConnectOptions) → `session.connect` →
    `buildQueryReply(enhanced)`。欠落経路なし。
- **GUI 入力の全経路**:
  - Web: ScreenGrid `@gui-select/@gui-submit` → EmulatorPane → session-controller → WS `gui-select/gui-submit`
    → ws-handler → `session.selectGuiChoice/submitGuiSelection`。
  - MCP: `select_gui_choice`/`submit_gui_selection` → 同 session API。
  - 両フロントが同一 core API に集約（契約整合）。
- **GUI 出力**: core buffer → `snapshot.gui` → server（text の `=== GUI ===`＋structuredContent の `gui`）
  ＋WS screen push → web オーバーレイ。QUERY 応答は enhanced 広告で GUI 構造体を誘発。
- **07 リンク化**: 純クライアント表示層（core/server は不変）。ScreenSnapshot の text セル基盤に非破壊で載る。
- **統合 test 通過**: 受け入れ基準 13 項目を自動 239＋実機 E2E 6 本（autosignon/mcp/ws/browser/dbcs-tls/
  gui-enhanced）で確認。ビルド・lint clean。
- **回帰**: enhanced 広告を有効化しても非 GUI 画面（自動サインオン→メニュー・MCP/WS/ブラウザ E2E）に
  影響なしを実機確認（06 の最大リスクを解消）。

### 指摘

- must: なし
- should: なし
- nit / 既知の制約（deliver の PR 本文「既知の制約」へ引き継ぎ）:
  1. 「MCP×Web 同時 2 フロント」を 1 スクリプトで同時操作する統合検証は未整備（session 分離は
     session-manager unit、各フロントは個別実機で確認済み）。
  2. カーソル F4 プロンプト・SEU カラー再現は unit/合成で担保、実機明示スクリプトは未整備。
  3. PUB400 標準画面に GUI 構造体が無く、GUI 実機疎通は合成 trace が正（06 decisions D1/D3）。
     選択肢テキストの DBCS・REM の厳密ヒットテストは主要サブセット外。

### 複雑度の自己評価（walkthrough 推奨判定・protocol 4.5）

- 差分が大きい（core/server/web-ui/tools の 4 パッケージ横断・約 7 subtask 分）。
- 複数モジュール横断（telnet ネゴ→5250 データストリーム→画面モデル→server→web の縦貫）。
- 処理フローが複雑（RFC 4777 自動サインオン・DBCS ステートフル変換・WSF/WDSF・拡張 5250 GUI）。
- → **3 トリガーすべて該当。walkthrough を推奨**（deliver 前にコード追跡説明で結合と主要判断を確認）。

### 判定

must/should なし → 統合 review 通過。**walkthrough（任意・推奨）**を挟んで deliver する提案。
