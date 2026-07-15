# タスク: 03-web

## server 側（WebSocket）
- [x] T1: WS メッセージ型＋ハンドラ — server に `ws-messages.ts`（open/key/jobinfo/close ← / opened/screen/
      jobinfo/error/closed →、ScreenSnapshot は core 由来）をエクスポート。`@hono/node-server` の
      upgradeWebSocket で /ws を実装（1 接続=1 セッション・SessionManager 経由・session "screen" イベントを
      push・readOnly ゲート・切断でセッション破棄）、serve() の websocket 結線。ユニット（メッセージ処理）
- [x] T2: Node WS E2E（実機）— /ws に Node WS クライアントで接続し open(profile)→opened(メニュー)→
      key(F1)→screen→jobinfo を実機 PUB400 で検証【実機】（依存: T1）

## web-ui（Vue 3）
- [x] T3: web-ui scaffold — Vite + Vue 3（vue・@vitejs/plugin-vue・typescript）、tsconfig、index.html、
      main.ts、App.vue 骨子、vitest + @vue/test-utils + jsdom、dev proxy（/api・/ws→server）（依存: T1）
- [x] T4: stores — `stores/sessions`（Map<sessionId, SessionState>：snapshot・編集差分・カーソル・接続状態・
      ws-client）、`stores/workspace`（分割ツリー・フォーカス・D&D 状態・狭幅フォールバック）、
      `stores/settings`（localStorage 接続設定・認証情報は保持しない）、`stores/log`（リング 500・sessionId タグ・
      hidden マスク・往復時間・JSONL）。ユニット（依存: T3）
- [x] T5: ws-client — セッション毎 WS 接続、送受信、stores/log フック、型は server と共有。ユニット（モック WS）（依存: T4）
- [x] T6: useTheme — system/light/dark・localStorage・data-theme・5250 7 色×2 テーマの CSS トークン・切替ボタン。
      ユニット（依存: T3）
- [x] T7: ScreenGrid — snapshot→行（`v-for`＋`v-memo`）、`<span>`/`<input>` インライン、属性→CSS class、
      DBCS 2ch 構造（描画は 04）、SO/SI・属性桁スペース、フォント自動フィット（ResizeObserver）、
      **入力は v-model 禁止**（`:value`＋beforeinput 検証＋composition ガード）。コンポーネントテスト（依存: T4, T6）
- [x] T8: CursorOverlay — ブロックカーソル・クリック/矢印移動。コンポーネントテスト（依存: T7）
- [x] T9: useKeymap — キー→AID（Enter/F1-24（Shift+F1-12=F13-24）/PageUp/Down）、Home/End/Tab/矢印の
      ローカル操作、ローカル編集キー（Field Exit/Erase EOF/Erase Input）、preventDefault 捕捉、
      フォーカスペインのみ、AID 時 {key,cursor,fields}。ユニット（依存: T4）
- [x] T10: ConnectView — サーバープロファイル（GET /api/profiles）＋ブラウザ保存設定の統合一覧、新規/編集
      フォーム、接続。コンポーネントテスト（依存: T4）
- [x] T11: StatusBar + SessionInfo — OIA（接続状態・keyboardLocked・カーソル・画面サイズ・TLS）＋タッチ F キー
      バー、セッション情報ポップオーバー（受動情報＋ジョブ情報取得ボタン→ws jobinfo）。コンポーネントテスト（依存: T5）
- [x] T12: LogPanel — 折りたたみドロワー、フィルタ（送信/受信/エラー/セッション別）、往復時間、JSON 展開、
      クリア、JSONL ダウンロード。コンポーネントテスト（依存: T4）
- [x] T13: Workspace + PaneTabs — 分割ツリーを flex ネストで描画、ディバイダ Pointer ドラッグでリサイズ、
      タブ D&D（中央=合流/上下左右=分割・5 ゾーンハイライト）、ペインフォーカス、狭幅フォールバック。
      コンポーネントテスト（依存: T4, T7, T11）
- [x] T14: App シェル統合 — App.vue で ConnectView ⇄ Workspace 遷移、theme 適用、全結線、build 成功（依存: T10, T13, T12, T9, T8）

## 統合・検証
- [x] T15: server 静的配信結線 — buildApp の webRoot に web-ui の dist を配信（serve-static）、CLI から指定可（依存: T14）
- [x] T16: Playwright E2E（実機）— chromium 導入、build+serve、接続→グリッド描画→フィールド入力→Enter/F キー
      遷移→テーマ切替→ログ表示 を自動検証【実機・PUB400】（依存: T15）
- [x] T17: web-ui 仕上げ — README（開発/ビルド）、不要物整理（依存: T16）
