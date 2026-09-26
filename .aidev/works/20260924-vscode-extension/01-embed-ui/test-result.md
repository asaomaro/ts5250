# テスト結果: 単一アプリ専用の最小WebView基盤（embed.html）

## 実行したもの
- `npx vitest run`（`packages/web-ui`）— 2669 passed / 0 failed / 0 skipped
- `npx vitest run`（`packages/server`）— 1610 passed / 0 failed / 3 skipped
  （既存の未関係skip。本subtaskでは増減なし）
- `npx vue-tsc --noEmit`（`packages/web-ui`）— エラー0
- `npm run build -w @ts5250/web-ui`（typecheck + vite build）— 成功。
  `dist/embed.html`・専用バンドル`embed-*.js`（gzip 2.69kB）が生成されることを確認
- `npm run lint`（リポジトリ全体）— エラー・警告0

## 受け入れ基準ごとの判定
（本subtaskが担当するのはT1〜T8の`AC:`欄に挙げたもの。AC3/4/5/7/8/9等は
02-extension-core/03-sql-ifsの担当）

- AC1: **partial pass**（review工程での言い直し——「pass」とだけ書くとAC1本文
  「.ts5250ファイルをVSCodeで開くと...WebViewタブとして表示される」を全数確認したように
  読めるが、このsubtaskにVSCode拡張機能はまだ無い）。確認できたのはWeb-UI/サーバー側の
  前提条件——実際に起動したサーバーへ`curl`し、`/embed.html?app=emulator`が正しい内容
  （`title>ts5250 embed`・`embed-*.js`参照）を返すこと（1度failしてから直した。下記
  「失敗の証跡」参照）。**VSCode WebViewとして実際に表示されるかはAC1の未検証の穴**
  （02-extension-core完了後に確認）
- AC2: pass — `EmbedApp.vue`はワークスペースUI（タブ帯・システム切替）を持たない。
  `embed-app.test.ts`で各app種別のマウント分岐を確認
- AC6: pass — `settings-form.test.ts`「入力して保存すると、入力値でsaveを発火する」
- AC-I2: pass — `settings-form.test.ts`のEscapeキャンセル・バックドロップクリック・保存の
  各テスト
- AC-I3: pass — `settings-form.test.ts`のTab/Shift+Tabフォーカストラップのテスト
- AC-I4: pass — `settings-form.test.ts`の初回autofocus・Escapeでのフォーカス復帰
  （キャンセル/保存後の呼び出し元へのフォーカス復帰はEmbedApp側の`.settings-btn`が
  受け皿になる設計。実機DOM上での目視確認は02側でVSCode WebViewに載せてから行う——
  「未検証の穴」参照）
- AC-I5: pass — `embed-app.test.ts`「systemRef未到着の間は...」等でSettingsFormと
  ペインが同時にDOMツリーの兄弟として存在し、キー処理が競合しない構造であることを
  コンポーネント構成で確認（実機でのキー入力確認はAC3同様02側）

## 失敗の証跡

自動テストでは検出できなかった欠陥を、**ビルド済み成果物を実際に起動してcurlする**
（AGENTS.md「実機で確定できることは、必ず実機で確定する」）ことで発見した。

```
$ node packages/server/dist/main.js --http 0 --web-root packages/web-ui/dist &
$ curl -s "http://127.0.0.1:$PORT/embed.html?app=emulator"
<!doctype html>
<html lang="ja">
  <head>
    ...
    <title>ts5250</title>
    ...
    <script type="module" crossorigin src="/assets/main-CtWAVSrd.js"></script>
    ...
```

`embed.html`ではなく`index.html`（`main-*.js`参照）の中身がそのまま返っていた。
原因は`packages/server/src/app.ts`のSPAフォールバック（`app.get("*", serveStatic({path:
"index.html", root}))`）が`/embed.html`も吸い込んでいたこと——既存の
`favicon.ico`等と同じ欠陥クラス（`test/web-static-icons.test.ts`の既存コメント参照）。

`packages/server/src/app.ts`に`app.use("/embed.html", serveStatic({root}))`を追加し、
`test/web-static-icons.test.ts`に回帰テストを足した。**修正を戻すとテストが落ちることを
確認済み**（mutation確認）:

```
$ git stash push -- packages/server/src/app.ts && npm run build -w @ts5250/server
$ npx vitest run test/web-static-icons.test.ts
 FAIL  test/web-static-icons.test.ts > アイコンの静的配信 > embed.html は index.html にすり替わらず実ファイルを返す
AssertionError: expected '<!doctype html><title>ui</title>' to match /ui embed/
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
$ git stash pop && npm run build -w @ts5250/server
$ npx vitest run test/web-static-icons.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

修正後、再度実機（起動したサーバー）へcurlして確認:

```
$ curl -s "http://127.0.0.1:$PORT/embed.html?app=emulator"
<!doctype html>
<html lang="ja">
  <head>
    ...
    <title>ts5250 embed</title>
    ...
    <script type="module" crossorigin src="/assets/embed-VZr3SvMW.js"></script>
    ...
http_status=text/html; charset=utf-8 size=671
```

これ以降のラウンドでは失敗は発生していない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260924-vscode-extension/01-embed-ui
note: 起動確認は work 全体の性質なので、記録は親 20260924-vscode-extension に刻みます
$ node launcher/smoke.mjs
{"level":40,...,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,...,"host":"127.0.0.1","port":38900,"auth":false,"msg":"5250 MCP/Web server started..."}
smoke: /healthz ok, / が Web UI を返した (port 38900)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

`smokeCommands`への`embed.html`個別追加は**このsubtaskでは行わない**——`embed.html`は
`postMessage`で接続情報を受け取るまで「設定を待っています…」のプレースホルダーしか
表示せず、拡張機能（`vscode-extension/`）が無い現時点では機能的な起動確認にならない
（開いて何が起きるかを確かめる価値のある状態は02-extension-core完了後）。
02-extension-core完了時に、拡張機能を実際に読み込んでの起動確認を追加するかを
その工程のtestで判断する。

## 未検証の穴（skip / 環境不足）

- **実機（PUB400等）への実接続（AC3相当）**: このsubtaskは`WsOpen`の組み立てまでを
  ユニットテストで検証しており、実際のIBM iへの接続は行っていない
  （`openSession()`自体をモックしている）。実接続の確認は、拡張機能から実際に
  子プロセスとして起動したサーバーを介す02-extension-coreのtest工程で行う
- **VSCode WebView実機でのフォーカス復帰・キー入力**: AC-I4のフォーカス復帰・AC-I5の
  キー操作非干渉は、jsdom上のコンポーネントテストで構造的に確認したのみ。
  実際のVSCode WebView（iframeを介した多段フレーム）上での目視確認は
  02-extension-core完了後に行う
- **`ifsPath`/`sqlInitial`の初期値反映**: `IfsPane.vue`/`SqlPane.vue`に対応するpropsが
  無いため未実装（design.mdに明記済みの既知の制限。requirementsのAC対象外）
