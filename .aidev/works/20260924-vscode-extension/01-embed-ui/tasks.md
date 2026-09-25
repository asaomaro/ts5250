# タスク: 単一アプリ専用の最小WebView基盤（embed.html）

親work（`20260924-vscode-extension`）design.md「設計方針4・5」・architecture.md
「メッセージプロトコル」を実装する。このsubtaskの範囲は`packages/web-ui`側のみ
（`vscode-extension/`はまだ存在しない・02で作る）。

## 実装方針

1. `embed-protocol.ts`（メッセージ型）を最初に作る——他の全モジュールがこれに依存する
2. Viteのマルチページ入力を追加し、最小の`embed.html`/`embed.ts`が単体で動く状態を確認
3. `EmbedApp.vue`（ペイン切り替え・設定ボタン）→`SettingsForm.vue`（フォーカストラップ）の順で
   組み立てる（`EmbedApp`が`SettingsForm`をマウントするため、先に完成させておくと結合時に
   モックで進められる）
4. 拡張機能（`vscode-extension/`）はまだ無いので、`window.parent`へのpostMessageは
   **ブラウザで直接開いても壊れない**よう、`window.parent === window`（トップレベルで
   直接開かれた場合）を検知して送信をスキップするガードを入れる（目視確認をVSCode無しで
   行うための最小限の配慮）

## 作業順序と依存関係

下の「依存」欄に従う。並行できるのはT2とT3（ともにT1のみに依存）。

## リスク / 留意点

- `SpoolPane.vue`/`SqlPane.vue`/`IfsPane.vue`は`{tabId, active?, system?}`という
  `EmulatorPane.vue`の`{sessionId, focused}`とは異なるprops形状を持つ
  （`SpoolPane.vue:33`/`SqlPane.vue:55`/`IfsPane.vue:49`。`decisions.md` D3の発覚経緯）。
  `EmbedApp.vue`はapp種別ごとに正しいprops形状で対応コンポーネントへ値を渡す
- `EmulatorPane.vue`は`systemsStore`を参照する（インポート確認済み）が、`workspaceStore`は
  参照しない（design.md E5で確認済み）。`SpoolPane.vue`/`SqlPane.vue`/`IfsPane.vue`も
  同様に`workspaceStore`は参照しない（今回追加確認。3ファイルとも`workspaceStore`の
  importが0件）——`EmbedApp.vue`がこれらをマウントするだけで動く前提の裏付け
- `systemsStore`の初期化（`/api/systems`・`/api/sessions-config`の取得。`stores/systems.ts:220-221`
  付近）は呼んでおく（emulatorの`system`色バッジ等、`system`未指定でも壊れない設計だが、
  printer/sql/ifsは`props.system`の解決に使うため必須）
- 拡張機能側（02-extension-core）とのメッセージ契約は`embed-protocol.ts`が正——
  `vscode-extension/src/protocol.ts`は02で手動複製し、両者の一致をテストで固定する
  （このsubtaskでは書かない。02への申し送り）

## テスト方針

- vitest + jsdom（既存`packages/web-ui`のテスト環境）でコンポーネント単体・`embed.ts`の
  メッセージハンドリングを検証する。VSCode拡張が無い状態のブラウザ単体確認は
  `npm run dev -w @ts5250/web-ui`後に`/embed.html?app=emulator`等を手動で開いて行う
  （このsubtaskのtest工程で実施）
- 実際のWS接続・実機確認は02-extension-core側（拡張機能が揃ってから）で行う。
  このsubtaskのtestは「メッセージを受けて正しいpropsで正しいコンポーネントをmountするか」
  「SettingsFormのフォーカス/保存/キャンセルが仕様どおりか」に閉じる（単独検証可能な範囲。
  `protocol-subtask.md`）

## タスク

- [x] T1: `packages/web-ui/src/embed-protocol.ts`を新規作成する（`HostToWebviewMessage`/
      `WebviewToHostMessage`/`ConnectPayload`/`SettingsFormValues`。architecture.md
      「メッセージプロトコル」の型定義をそのまま実装に落とす）
      対象: 新規作成（参照: `architecture.md`「メッセージプロトコル」）
      依存: なし
      AC: なし
- [x] T2: `packages/web-ui/vite.config.ts`にマルチページ入力を追加する
      （`build.rollupOptions.input: { main: "index.html", embed: "embed.html" }`）
      対象: `packages/web-ui/vite.config.ts:1-16`（既存の`build: { outDir: "dist" }`を拡張）
      依存: なし
      AC: なし
- [x] T3: `packages/web-ui/embed.html`を新規作成する（`index.html`を参考にした最小HTML。
      `<div id="app">` + `src/embed.ts`をscript module読み込み）
      対象: `packages/web-ui/index.html`を参考に新規作成
      依存: T2
      AC: AC1
- [x] T4: `packages/web-ui/src/embed.ts`を新規作成する（URLクエリから`app`を読む→
      `window.addEventListener("message", ...)`で`ready`ハンドシェイク送信・
      `connect`/`saved`/`saveError`/`fileInvalid`受信→`EmbedApp.vue`をmount。
      `window.parent === window`ガード含む）
      対象: `packages/web-ui/src/embed.ts`（起点）＋`packages/web-ui/src/stores/embed.ts`
      （メッセージ橋渡し本体。既存の`stores/*.ts`パターンに合わせて分離。実装時の判断）
      依存: T1, T3
      AC: AC1, AC2
- [x] T5: `packages/web-ui/src/components/SettingsForm.vue`を新規作成する（host/port/tls/
      ccsid/deviceName/user/passwordの入力欄。最初の入力欄へ`autofocus`・`Tab`循環・
      `Escape`でキャンセルしフォーカスを呼び出し元へ戻す・保存で`save`メッセージ発火）
      対象: 新規作成（参照: `InfoPopover.vue`のバックドロップ意匠・`focusTrap.ts`の
      `OVERLAY_SELECTOR`パターン）
      依存: T1
      AC: AC6, AC-I2, AC-I3, AC-I4
- [x] T6: `packages/web-ui/src/EmbedApp.vue`を新規作成する（`ConnectPayload.app`に応じて
      `EmulatorPane`（props: `sessionId`, `focused`）／`SpoolPane`・`SqlPane`・`IfsPane`
      （props: `tabId`, `active`, `system`）を出し分けてmount。設定ボタン→`SettingsForm`表示。
      `openSession()`呼び出しはemulatorのときだけ行い、他のapp種別は`systemRef`をそのまま
      propsの`system`へ渡す）
      対象: 新規作成（参照: `EmulatorPane.vue:42`, `SpoolPane.vue:33`, `SqlPane.vue:55`,
      `IfsPane.vue:49`, `session-controller.ts:745`の`openSession()`）
      依存: T4, T5
      AC: AC1, AC2, AC-I1, AC-I5
- [x] T7: T1〜T6のコンポーネント/モジュールテストを書く（`embed.ts`のメッセージ処理・
      `EmbedApp.vue`のapp種別ごとのマウント分岐・`SettingsForm.vue`のフォーカス移動/
      Tab循環/Escape/保存メッセージ）
      対象: `packages/web-ui/test/`配下に新規（既存テストの配置慣習に合わせる）
      依存: T6
      AC: AC-I2, AC-I3, AC-I4, AC-I5
- [x] T8（test工程で発見・追加）: `packages/server`のSPAフォールバック
      （`app.get("*", serveStatic({path:"index.html"}))`）が`/embed.html`も吸い込み、
      `index.html`を返していた（実機確認で発覚）。`/favicon.*`と同じ理由で個別配信を追加
      対象: `packages/server/src/app.ts:364-367`（`favicon`配信の直後に`embed.html`を追加）
      依存: T3
      AC: AC1
