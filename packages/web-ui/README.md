# @as400web/web-ui

ブラウザで 5250 画面を表示・操作する Web エミュレーター（Vue 3 + Vite）。
`@as400web/server` の WebSocket（1 接続 = 1 セッション）に接続する。

## 開発

```sh
# server を起動しておく（別ターミナル）
node packages/server/dist/main.js --http 3400 --profiles profiles.json

# web-ui 開発サーバー（/api・/ws は 3400 にプロキシ）
npm run dev -w @as400web/web-ui
```

## ビルド＋本番配信

```sh
npm run build -w @as400web/web-ui      # → packages/web-ui/dist
node packages/server/dist/main.js --http 3400 --profiles profiles.json \
  --web-root packages/web-ui/dist       # server が dist を静的配信
```

## 構成（design の web-ui モジュール表に対応）

- `stores/` — sessions（画面・編集差分・カーソル・WS クライアント）/ workspace（分割ツリー・フォーカス・D&D）/
  settings（localStorage 接続設定・**認証情報は保持しない**）/ log（リング 500・sessionId タグ・**hidden マスク**・
  往復時間・JSONL）
- `ws-client.ts` — 1 セッション = 1 WebSocket。送受信を log にフックし、送信時に hidden フィールド値を伏字化
- `session-controller.ts` — WS とストアの結線（open/key/jobinfo/close）
- `components/ScreenGrid.vue` — 固定グリッド描画。属性→CSS class、フィールドは inline `<input>`
  （**v-model 禁止**: `:value`＋beforeinput 検証＋composition ガード）、フォント自動フィット（ResizeObserver）
- `components/WorkspaceNode.vue` / `PaneTabs.vue` — タブ＋ペイン分割（ディバイダ Pointer リサイズ・タブ D&D の 5 ゾーン）
- `components/StatusBar.vue` / `SessionInfo.vue` — OIA＋タッチ F キーバー / セッション情報＋ジョブ情報取得
- `components/ConnectView.vue` — サーバープロファイル＋ブラウザ保存設定の統合一覧
- `components/LogPanel.vue` — 操作ログドロワー（フィルタ・往復時間・JSON 展開・JSONL）
- `composables/useKeymap.ts` — キー→AID（F1-24・Enter・PageUp/Down）、ローカル操作、preventDefault 捕捉、
  **カスタムキーバインド**（keybindings ストア）を優先
- `composables/useTheme.ts` — 通常/ダーク・system 追従・localStorage・5250 7 色×2 トークン
- `composables/fieldEdit.ts` — 5250 フィールド編集モデル（**上書き既定・Insert トグル・5250 流バックスペース**・
  Delete・カーソル・paste 整形）。ScreenGrid が native input の keydown を制御して適用
- `composables/fieldValidate.ts` — 入力時の型（数値/A/O/J）・全角判定による受理チェック
- `stores/keybindings.ts` — カスタムキーバインド（localStorage・action→key）
- 表示トグル: SO/SI を `{`/`}` 表示、半角カナ表示（`@as400web/core/codec` の katakanaChar で英小文字位置をカナ再解釈）

## 検証

- コンポーネント/ユニット: `npm test -w @as400web/web-ui`
- ブラウザ E2E（Playwright・実機 PUB400）: `node --env-file=.env scripts/verify-browser.mjs`

## 対応範囲

SBCS・24x80。DBCS（2ch 描画・CJK 等幅フォント実測選定）・27x132・TLS は subtask 04 で追加。
