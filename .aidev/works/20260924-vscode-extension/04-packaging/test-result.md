# テスト結果: `.vsix`パッケージング

## 実行したもの
- `cd vscode-extension && npx tsc -b` — 0 errors（実ビルド。dist/ 生成）
- `cd vscode-extension && npx tsc -b tsconfig.test.json` — 0 errors（テスト込みの型検査）
- `cd vscode-extension && npx vitest run` — 66 passed / 0 failed / 0 skipped（10 test files）
- `node vscode-extension/scripts/prepare-server.mjs` — 実行成功（132 packages, 14.5MB のソースマップ/型定義を除去）
- `npx @vscode/vsce package`（vscode-extension/ で実行） — 実行成功、警告0件（初回は `repository`欠落・
  LICENSE欠落・.vscodeignore欠落の3件の警告が出たため、それぞれ対処してから再実行して解消を確認）
- `aidev smoke`（work全体） — pass（親 `20260924-vscode-extension` に記録。下記「起動確認」参照）

## 受け入れ基準ごとの判定
このsubtaskの全タスクは `AC: なし`（`tasks.md`のとおり。パッケージングは要件のACに直接紐づかない
実装上の作業）。代わりに`tasks.md`「テスト方針」の3項目で判定する。

- **`prepare-server.mjs`の実行 → 生成物から直接`node`起動 → healthzが通る**: pass — 生成された
  `server-stage/`から実際に`node`で（`ServiceManager.defaultSpawnServer`と全く同じ引数で）
  サーバーを起動し、`/healthz`・`/`・`/embed.html`がいずれも200を返すことを確認した（下記「証跡」）。
- **`resolveRoot`のdev/packaged分岐が単体テストで確認できる**: pass — `vscode-extension/test/extension.test.ts`
  に`context.extensionMode`をDevelopment/Productionそれぞれに設定した2ケースを追加し、期待する
  `serverMainPath`/`webRootPath`が返ることを確認した（T2で追加、66件のうちの一部として毎回実行される）。
- **`vsce package`を実行し、`.vsix`の中身を検査する**: pass — 実際に生成した`.vsix`を`unzip -l`で
  独立に検査し、`extension/dist/extension.js`・`extension/package.json`・`extension/LICENSE.txt`・
  `extension/server-stage/node_modules/@ts5250/server/dist/main.js`が含まれる一方、
  `extension/test/`・`extension/src/`・`extension/tsconfig*`・`extension/vitest.config.mts`が
  含まれないことを確認した。

## 実プロセス検証の証跡

### server-stage の直接起動（T1・再確認）
```
$ node extension/server-stage/node_modules/@ts5250/server/dist/main.js --http 35777 \
    --web-root extension/server-stage/packages/web-ui/dist --profiles /tmp/vsix-check-profiles.json
ENOENT: profiles ファイルが無いと拒否される（--profilesは事前に存在するファイルを要求する仕様。
ServiceManagerは--profilesを渡さないため、これは検証対象の実引数と異なると判明——引数を修正して再実行）
```

### `.vsix`から展開した server-stage を、ServiceManager と全く同じ引数で起動（最終確認）
`vscode-extension/src/serviceManager.ts`の`defaultSpawnServer`が実際に組み立てる引数
（`--http` `--web-root` `--connections` `--auto-secret-key` `--secret-key-file`、
`ELECTRON_RUN_AS_NODE=1`）をそのまま使用:
```
$ unzip -q ts5250-vscode-0.1.0.vsix   # 実際に vsce package で生成した.vsix
$ ELECTRON_RUN_AS_NODE=1 node extension/server-stage/node_modules/@ts5250/server/dist/main.js \
    --http 35778 --web-root extension/server-stage/packages/web-ui/dist \
    --connections /tmp/vsix-check-connections.json \
    --auto-secret-key --secret-key-file /tmp/vsix-check.env
{"level":30,...,"msg":"generated master key for single-user mode"}
{"level":30,...,"host":"127.0.0.1","port":35778,"auth":false,"msg":"5250 MCP/Web server started ..."}

healthz: 200
index: 200
embed: 200
```
`.vsix`単独で自己完結して動くことを、実際にzipを展開してから確認した（生成スクリプトの出力を
信頼するのではなく、配布物そのものを検証した）。

### `.vsix`内容の独立検査（vsceの表示を鵜呑みにしない）
```
$ unzip -l ts5250-vscode-0.1.0.vsix | grep -E "extension/(package\.json|dist/extension\.js|LICENSE)"
    11358  ...  extension/LICENSE.txt
     1082  ...  extension/package.json
     8951  ...  extension/dist/extension.js
$ unzip -l ts5250-vscode-0.1.0.vsix | grep -E "extension/(test/|src/|tsconfig|vitest\.config)"
（該当なし）
$ unzip -l ts5250-vscode-0.1.0.vsix | grep "server/dist/main.js"
    17750  ...  extension/server-stage/node_modules/@ts5250/server/dist/main.js
```

## 起動確認（smoke）
work全体の性質のため、記録は親 `20260924-vscode-extension` の smoke に刻まれる
（`aidev smoke`実行時のnote参照）。既存の`smokeCommand`（`node launcher/smoke.mjs`）で
コアサーバーの起動確認は既にカバーされている。

```
$ node launcher/smoke.mjs
{"level":30,...,"msg":"5250 MCP/Web server started (localhost only. ...)"}
smoke: /healthz ok, / が Web UI を返した (port 39060)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

**`smokeCommands`にVSCode拡張専用のエントリは追加しなかった**。理由:
- `server-stage/`は`.gitignore`済みの生成物（`prepare-server.mjs`が都度作り直す）で、リポジトリの
  常設ツリーには存在しない。恒常的なsmokeの対象にするには毎回`npm install`（ネットワーク依存）を
  要求することになり、smokeの「速く・必ず終わる」性質と合わない。
- 同種の配布チャネルである`electron/`も、既存の`.aidev/config.yml`に専用のsmokeCommandsエントリを
  持たない（コアサーバーの起動確認は共有の`launcher/smoke.mjs`に一本化されている先例）。
- パッケージング固有のリスク（`server-stage/`の自己完結性・`.vsix`の中身）は、上記「実プロセス検証の証跡」
  でこのtest工程内で直接・実プロセスで確認済み。

## ラウンド2（review round1差し戻し対応後の再検証）

`review.md`ラウンド1の指摘（`server-stage/`レイアウトの対応関係が固定されていない）を受けて
T4（`test/serverStageLayout.test.ts`）を追加した後の再実行:

- `cd vscode-extension && npx tsc -b` — 0 errors
- `cd vscode-extension && npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **68 passed / 0 failed / 0 skipped**（11 test files。
  T4追加分の2件が純増）
- `npx eslint vscode-extension/test/serverStageLayout.test.ts` — 0 errors

このラウンドでは失敗は発生していない。

## 未検証の穴（skip / 環境不足）
- **VSCode拡張ホスト自体からの`.vsix`インストール・起動は未検証**。このコンテナには
  `--extensionDevelopmentPath`/`.vsix`インストールを駆動できるVSCode拡張ホスト環境が無い
  （`02-extension-core`の「未検証の穴」と同じ制約。`context.extensionMode === Production`の分岐が
  実際にVSCodeによって選ばれるかどうかは、拡張ホスト無しには確認できない）。
  この制約は別セッション（"VSCode拡張機能の自動テスト環境"）が扱っている（`decisions.md`参照は無いが、
  `02-extension-core/tasks.md`「リスク/留意点」に記載済み）。
- **`vsce publish`（Marketplaceへの公開）は未実施・未検証**。requirements/design で「まず`.vsix`の
  ローカルインストールのみ」と明示的にスコープ外にしている。
