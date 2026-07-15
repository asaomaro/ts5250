# 計画: 03-web — WebSocket ハンドラ＋Vue 3 Web UI

親: 20260714-5250-mcp-web-emulator（scope は親 plan.md の境界表で凍結済み。分解のみ・再分割なし）
依存: 02-server-mcp（review 承認済み）

## 実装方針

- **server の WebSocket ハンドラ**（1 接続 = 1 セッション・screen push・readOnly）を先に作り、
  Node の WS クライアントで実機検証してから web-ui を積む。
- web-ui は **Vue 3（Composition API・`<script setup>`）+ Vite**。design の web-ui モジュール表に 1:1 対応。
  グリッド入力は **v-model 禁止**（`:value`＋`beforeinput`＋composition ガード。D7）。状態は reactive の
  小さな store 群（Pinia なし）。分割ツリー・D&D は自作。
- WS メッセージ型は **server で定義しエクスポート**、web-ui は type-only import で共有（ScreenSnapshot は core 由来）。
- 検証は **Playwright ヘッドレス自動化**（グリッド描画・キー操作・画面遷移）＋コンポーネントテスト（jsdom）＋
  Node WS クライアントの実機 E2E。

## 受け入れ基準（この subtask で検証する Web 系・SBCS 分）

- Web ブラウザで 5250 画面が表示され、フィールド入力と Enter/F キー操作で画面遷移できる（SBCS）。
- フィールド属性（非表示＝マスク、入力可否）とカラーが Web 表示に反映される。
- 24x80 で表示が崩れない（27x132・DBCS は 04）。
- カーソル位置指定で F キー送信、テーマ切替、ペイン分割・接続画面・操作ログの動作。

## リスク / 留意点

- **@hono/node-server の内蔵 WebSocket**（`upgradeWebSocket`）を使う（@hono/node-ws は deprecated）。
  serve() の websocket オプション結線に注意。
- **フォント自動フィット**は ResizeObserver で。等幅・全角=半角×2 の実測フォント選定は 04（DBCS）だが、
  SBCS 描画の桁固定は 03 で担保（`ch` 単位）。
- **D&D の複雑さ**: Workspace は先にキーボード/タブのみで動かし、D&D を後付け（Pointer Events）。
- Playwright はヘッドレス Chromium を入れる（`playwright install chromium`）。CI 非前提のローカル検証。
- 実機接続テストは PUB400 の接続制限に配慮し直列・少接続。

## テスト方針（protocol 2.8・この subtask の範囲）

- コンポーネント（@vue/test-utils + jsdom）: ScreenGrid（属性→class・マスク・桁保持）、stores（log マスク・
  workspace 分割ツリー操作）、useKeymap（キー→AID マッピング・捕捉）、useTheme、ConnectView（一覧統合）。
- Node WS E2E（実機）: /ws に接続し open→screen→key→screen→jobinfo を実機 PUB400 で検証。
- Playwright（実機）: build した web-ui を server 静的配信で起動し、接続→グリッド描画→フィールド入力→
  Enter/F キーで画面遷移→テーマ切替→ログ表示 を自動検証。
- DBCS・TLS・27x132・複数同時セッションの結合は 04・親統合 test に委ねる。
