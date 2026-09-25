# タスク: VSCode拡張機能本体（vscode-extension/）

親work design.md「設計方針1・2・5・7」・architecture.md「コンポーネント/モジュール」
「メッセージプロトコル」「ロックファイルの状態遷移」を実装する。このsubtaskの範囲は
`vscode-extension/`一式。**エミュレータのみ**（`WsOpen`直接接続。design.md「設計方針3」訂正後）
がエンドツーエンドで動く状態を目指す。プリンター/スプール表示・SQL・IFSは03-sql-ifsの担当。

## 実装方針

1. `vscode-extension/`をリポジトリ直下に新設（`electron/`と同じ立て付け）。まず骨格
   （`package.json`/`tsconfig.json`）を作る
2. 他モジュールが依存しない・依存が少ないものから積む: `protocol.ts`（型のみ）→
   `secretCrypto.ts`→`schema.ts`→`webviewHtml.ts`（いずれも`vscode`モジュールに依存しない
   純粋ロジック）
3. `vscode`モジュールへの依存が生じる箇所（`ts5250EditorProvider.ts`・`extension.ts`）は
   **手書きのモックハーネス**でユニットテストする——本物のVSCode拡張ホストは
   このコンテナに無い（`code`はWSL越しのWindows側バイナリで、ここから
   `--extensionDevelopmentPath`を渡しても本コンテナからは検証できない。`Xvfb`も無い。
   `@vscode/test-electron`によるヘッドレス実行環境の整備は**別セッションで進行中**
   （ListAgentsで確認した「VSCode拡張機能の自動テスト環境」）——本subtaskで重複整備しない）
4. `serviceManager.ts`は**注入可能な依存**（spawn関数・healthzを叩くfetch関数・
   lockファイルの読み書き）で単体テストしたうえで、**実際に`packages/server`を
   spawnする統合テスト**も別途行う（プロセス管理の本質的な正しさは注入したモックだけでは
   確認しきれないため）
5. 最後に`extension.ts`で全体を結線する

## 作業順序と依存関係

下の「依存」欄に従う。T2〜T5は互いに依存せずT1後に並行できる。

## リスク / 留意点

- **VSCode拡張ホストでの実地動作確認はこのsubtaskでは行えない**（上記「実装方針」3）。
  test工程の`test-result.md`「未検証の穴」に明記し、`decisions.md`にも経緯を残す
- `packages/server`の`main()`はSIGINT/SIGTERMで`process.exit(0)`する
  （research F3）。`ServiceManager`は**別プロセス**として`spawn`し、
  `ELECTRON_RUN_AS_NODE=1`でシステムNode不要にする（research F2）
- master keyは`vscode.ExtensionContext.secrets`（`SecretStorage`）に保持する。
  モックハーネスは`Map`ベースの簡易実装で足りる（`SecretStorage`のAPI面は
  `get`/`store`/`delete`の3つだけ）
- `protocol.ts`は`packages/web-ui/src/embed-protocol.ts`と**手で同期を保つ**
  （型のみのファイルなので、内容を実質的に同一に保ち、テストで一致を固定する）

## テスト方針

- 純粋ロジック（`protocol.ts`は型のみなのでテスト対象外・`secretCrypto.ts`・`schema.ts`・
  `webviewHtml.ts`・`serviceManager.ts`の単体部分）はvitestで検証する
- `serviceManager.ts`は実際に`packages/server`をspawnする統合テストも行う
  （`.env`/`.env.verify`は使わない——ここで確認するのはプロセスの起動・healthz・
  停止であり、実機接続ではない）
- `ts5250EditorProvider.ts`/`extension.ts`は手書きの`vscode`モックで単体テストする
- **AC3（実際にホストへ接続できる）は、実際に起動したサーバーへWS直接接続して
  `.env`/`.env.verify`の検証環境（PUB400等）に繋ぐスクリプトで確認する**
  （VSCode拡張機能を介さず、`ts5250EditorProvider`が組み立てる`WsOpen`と同じ形の
  メッセージを直接送る。「エミュレータの接続経路」自体の正しさは確認できるが、
  WebView表示そのものはこの方法では確認できない——上記「未検証の穴」と同じ限界）

## タスク

- [x] T1: `vscode-extension/`を新設する（`package.json`——`name`/`engines.vscode`/
      `activationEvents`/`main`/`contributes.customEditors`（`.ts5250`拡張子・
      viewType仮決め）の骨格、`tsconfig.json`、`src/`ディレクトリ）
      対象: 新規（参照: `electron/package.json`の立て付け）
      依存: なし
      AC: なし
- [x] T2: `vscode-extension/src/protocol.ts`を新規作成する（`packages/web-ui/src/
      embed-protocol.ts`と型定義を同一に保つ）。同期を固定するテストを追加
      （両ファイルの型定義部分をテキスト比較する等）
      対象: `packages/web-ui/src/embed-protocol.ts`を手で複製
      依存: T1
      AC: なし
- [x] T3: `vscode-extension/src/secretCrypto.ts`を新規作成する（AES-256-GCM。
      `v1:iv:tag:ct`形式。`vscode.SecretStorage`からmaster keyを取得/自動生成する
      ファクトリ関数）。単体テストを書く
      対象: 新規（参照: `packages/server/src/secret-crypto.ts`の形式のみ。
      コードは独立実装——design.md「設計方針2」）
      依存: T1
      AC: AC7
- [x] T4: `vscode-extension/src/schema.ts`を新規作成する（`.ts5250`のJSON検証。
      design.md「インターフェース/データ構造」のスキーマをそのまま実装）。単体テストを書く
      対象: 新規（参照: design.md「`.ts5250`ファイルスキーマ」）
      依存: T1
      AC: AC1
- [x] T5: `vscode-extension/src/webviewHtml.ts`を新規作成する（shell HTMLの文字列生成。
      CSP・nonce・iframe・postMessage中継スクリプト。research F1のSimple Browser方式）。
      単体テストを書く（生成された文字列の構造を検証）
      対象: 新規（参照: research F1の`SimpleBrowserView.getHtml()`と同型の構成。
      `microsoft/vscode` `extensions/simple-browser/src/simpleBrowserView.ts`）
      依存: T1
      AC: AC1
- [x] T6: `vscode`モジュールの手書きモックハーネスを作る
      （`vscode-extension/test/vscode-mock.ts`。`SecretStorage`・`Webview`・
      `WebviewPanel`・`CustomTextEditorProvider`・`ExtensionContext`のうち
      使う面だけ）
      対象: 新規
      依存: T1
      AC: なし
- [x] T7: `vscode-extension/src/serviceManager.ts`を新規作成する（ロックファイルの
      読み書き・spawn・healthzポーリング・ハートビート・acquire/release。
      architecture.md「ロックファイルの状態遷移」のstateDiagramを実装）。
      spawn関数・fetch関数・fs操作を注入可能にし、単体テストではモックで検証する
      対象: 新規（参照: `electron/main.cjs`の`findFreePort`/`waitForHealth`パターン。
      research A1）
      依存: T1
      AC: AC4, AC5
- [x] T8: T7の実プロセス統合テストを書く（実際に`packages/server`の`dist/main.js`を
      spawnし、healthz到達・`kill()`での終了を確認する）
      対象: `vscode-extension/test/`配下に新規
      依存: T7
      AC: AC4, AC5
- [x] T9: `vscode-extension/src/ts5250EditorProvider.ts`を新規作成する
      （`CustomTextEditorProvider`。`resolveCustomTextEditor`・WebView生成
      （`webviewHtml.ts`使用）・`.ts5250`のパース（`schema.ts`使用）・
      復号（`secretCrypto.ts`使用）・`connect`メッセージ送信・`save`メッセージ受信時の
      `WorkspaceEdit`書き戻し・暗号化）。T6のモックで単体テストする
      対象: 新規（参照: architecture.md「振る舞いの詳細」の各シーケンス図）
      依存: T2, T3, T4, T5, T6, T7
      AC: AC1, AC6, AC7, AC9, AC-I1, AC-I2
- [x] T10: `vscode-extension/src/extension.ts`を新規作成する（`activate`/`deactivate`。
      `windowId`生成・`Ts5250EditorProvider`の登録・`ServiceManager`の生成）。
      `package.json`の`contributes.customEditors`/`activationEvents`/`main`を最終確定する。
      T6のモックで単体テストする
      対象: 新規
      依存: T9
      AC: AC1, AC3
