# @ts5250/web-ui

ブラウザの端末エミュレーター（**5250 / 3270 / VT**）と、IBM i の機能画面（SQL・IFS・
データ待ち行列・メッセージ …）を提供する（Vue 3 + Vite）。端末は `@ts5250/server` の
WebSocket（**1 接続 = 1 セッション**）、機能画面は REST（`/api/host/*`）を使う。

見た目・振る舞いの規約は [`docs/UI-DESIGN.md`](../../docs/UI-DESIGN.md)。

## 開発

```sh
# server を起動しておく（別ターミナル）
node packages/server/dist/main.js --http 3400 --profiles profiles.json

# web-ui 開発サーバー（/api・/ws は 3400 にプロキシ）
npm run dev -w @ts5250/web-ui
```

## ビルド＋本番配信

```sh
npm run build -w @ts5250/web-ui      # → packages/web-ui/dist
node packages/server/dist/main.js --http 3400 --profiles profiles.json \
  --web-root packages/web-ui/dist       # server が dist を静的配信
```

## 構成

- `stores/` — sessions（画面・編集差分・カーソル・WS クライアント）/ vt（VT の画面）/
  workspace（タブ・タブグループ・分割ツリー・フォーカス・D&D）/ systems / services / watches /
  macros / auth / appearance（アプリ全体の外観）/ viewSettings（**ペイン単位の表示**）/
  connections（**接続設定はサーバー保存**。localStorage 保存は廃止＝単一の真実はサーバー。
  **認証情報はブラウザに保持しない**——パスワードはサーバーで AES-256-GCM 暗号化され、
  API は平文も暗号文も返さない）/ log（リング 500・sessionId タグ・**hidden マスク**・往復時間・JSONL）
- 接続設定は**システム**（接続先＋資格情報）と**セッション設定**（装置名・画面サイズ・種別）の
  2 階層で、参照は `srv:<name>`（サーバー設定）/ `own:<id>`（個人設定）。
  **PDF 自動蓄積・自動印刷などの信頼設定はサーバー設定のセッションのみ**が持ち、
  ブラウザ入力からは注入できない（サーバー側で拒否する）。
  localStorage に残すのはテーマとキーバインドだけ。
- `ws-client.ts` — 1 セッション = 1 WebSocket。送受信を log にフックし、送信時に hidden フィールド値を伏字化
- `session-controller.ts` — WS とストアの結線（open/key/jobinfo/close）
- `components/ScreenGrid.vue` — 固定グリッド描画。属性→CSS class、フィールドは inline `<input>`
  （**v-model 禁止**: `:value`＋beforeinput 検証＋composition ガード）、フォント自動フィット（ResizeObserver）
- `components/WorkspaceNode.vue` / `PaneTabs.vue` / `PanePool.vue` / `TabGroupMenu.vue` —
  タブ＋タブグループ＋ペイン分割（ディバイダ Pointer リサイズ・タブ D&D の 5 ゾーン）。
  **開いたタブは閉じるまで生きる**ので実体は `PanePool` がグループから切り離して保持する
- `components/StatusBar.vue` / `SessionInfo.vue` — OIA＋タッチ F キーバー / セッション情報＋ジョブ情報取得
- `components/ConnectView.vue` — サーバー設定＋自分の設定の統合一覧（どちらもサーバー保存）
- `components/LogPanel.vue` — 操作ログドロワー（フィルタ・往復時間・JSON 展開・JSONL）
- `composables/useKeymap.ts` — キー→AID（F1-24・Enter・PageUp/Down）、ローカル操作、preventDefault 捕捉、
  **カスタムキーバインド**（keybindings ストア）を優先
- `composables/useTheme.ts` / `useSkin.ts` — 通常/ダーク・system 追従・localStorage・5250 7 色×2 トークン、
  画面の質感（フラット / CRT）や入力欄・ボタンの意匠
- `composables/fieldEdit.ts` — 5250 フィールド編集モデル（**上書き既定・Insert トグル・5250 流バックスペース**・
  Delete・カーソル・paste 整形）。ScreenGrid が native input の keydown を制御して適用
- `composables/fieldValidate.ts` — 入力時の型（数値/A/O/J）・全角判定による受理チェック
- `stores/keybindings.ts` — カスタムキーバインド（localStorage・action→key）
- 表示トグル: SO/SI を `{`/`}` 表示、半角カナ表示（`@ts5250/tn5250/codec` の katakanaChar で英小文字位置をカナ再解釈）

## 主なペイン

| ペイン | 役割 |
|---|---|
| `EmulatorPane` | 5250 / 3270 の画面（フィールド＋AID キー） |
| `VtPane` | VT / xterm の画面（**文字モード**。フィールドも AID も無く、スクロールバックを持つ） |
| `PrinterPane` / `ReportText` | 受信スプールの一覧とビュー（等幅・改ページ保持） |
| `LauncherPane` | 接続画面（システム／セッション／このシステムの機能／アプリ） |
| `SqlPane` / `SqlResultTable` / `SqlCompletion` / `SqlLogPanel` | SQL の実行・結果表（仮想化）・補完・履歴 |
| `PlanViewer` / `PlanGraph` / `PlanListPane` | 実行計画（ACS の Visual Explain 相当）とプランキャッシュ一覧 |
| `TransferPane` | データ転送（表 ⇔ CSV） |
| `IfsPane` | IFS のブラウズ・取得・配置・zip 一括取得 |
| `DtaqPane` / `WatchPane` | データ待ち行列の操作 / 待ち受けの購読と履歴 |
| `MessagePane` | メッセージ待ち行列（**照会への応答**を含む） |
| `CommandPane` | CL コマンドのプロンプト UI（実機の F4 相当） |
| `ProgramPane` / `PcmlPane` | プログラム呼び出し（型付き引数 / `.pcml`） |
| `HostListPane` / `SpoolPane` | ジョブ・オブジェクト・ユーザーの一覧 / 既存スプールの検索 |
| `ServicesPane` | サーバー側の常駐サービス（プリンター・待ち行列）の一覧と開始・停止 |
| `AdminPane` | ユーザー管理・全セッション管理・監査ログ |

## 検証

- コンポーネント/ユニット: **パッケージ dir から実行する**（`cd packages/web-ui && npx vitest run`）。
  ルートから実行すると Vite の vue plugin とフィクスチャの相対パスが解決されず、実際とは違う失敗が出る。
- ブラウザ E2E（Playwright・実機 PUB400）: `node --env-file=.env scripts/verify-browser.mjs`
- **ビルドに `vue-tsc` を含める**（`npm run build` = `typecheck` → `vite build`）。
  `vite build` はテンプレートの型チェックをしない。

## 対応範囲

SBCS ＋ **DBCS**（2ch 描画・CJK 等幅フォントの実測選定）、**24x80 / 27x132**、平文 ＋ **TLS**。
端末は **5250 / 3270 / VT**。
