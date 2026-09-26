# タスク: `.vsix`パッケージング

親work design.md「対象範囲」・architecture.md「tasksへの申し送り」の
`scripts/prepare-server.mjs`・`.vscodeignore`・`vsce package`を実装する。
このsubtaskの範囲は`vscode-extension/`のパッケージング一式（配布物のレイアウト確定・
実行時依存の同梱・`.vsix`の実際の生成）。

## 実装方針

1. `electron/scripts/prepare-app.mjs`を土台に、`vscode-extension/scripts/
   prepare-server.mjs`を作る（依存の集め方・第三者依存の`npm install`・
   自前パッケージの実体コピーはelectron版と同じロジック。出力先だけ
   `vscode-extension/server-stage/`に変える）
2. `extension.ts`の`resolveRoot`（dev決め打ち）を、`context.extensionMode`で
   dev/packagedを分岐する形に直す（`02-extension-core`時点ではpackaged側を
   実装していなかった。`02-extension-core/tasks.md`「実装方針」3の宣言どおり）
3. `.vscodeignore`・`package.json`の配布向けフィールドを整え、実際に
   `npx @vscode/vsce package`で`.vsix`を生成して検証する

## 作業順序と依存関係

T1（staging）→T2（packaged時のパス解決。T1の出力レイアウトに依存）→T3（.vsix生成。
T1・T2の両方に依存）の順。

## リスク / 留意点

- **`context.extensionMode`はVSCode拡張APIの値**（`vscode.ExtensionMode.Development`/
  `Production`/`Test`）。`--extensionDevelopmentPath`での起動時は`Development`、
  インストール済み`.vsix`からの起動時は`Production`になる（VSCode公式ドキュメントの
  定義）。本物のVSCode拡張ホストが無いこのコンテナでは、この分岐の**実地確認はできない**
  ——`prepare-server.mjs`が生成した`server-stage/`を実際に`node`で直接起動して
  「レイアウトとして正しいか」までは確認できるが、「VSCodeが実際にPackaged扱いで
  この分岐を通るか」はVSCode拡張ホスト無しには確認できない（`02-extension-core`の
  「未検証の穴」と同じ制約）
- `vsce package`が要求するフィールド（`repository`・`license`・アイコン等）は
  実際にコマンドを打って出るエラー/警告に従って埋める（推測で先回りしない）

## テスト方針

- `prepare-server.mjs`は実際に実行し、生成された`server-stage/`から
  実際に`node server-stage/packages/server/dist/main.js`を起動して healthz が
  通ることを確認する（実プロセス検証）
- `resolveRoot`のdev/packaged分岐は`vscode`モックで単体テストする
  （`context.extensionMode`を切り替えて期待パスを確認）
- `vsce package`を実際に実行し、生成された`.vsix`（zip形式）の中身を検査して
  `dist/extension.js`・`server-stage/...`が含まれ、`test/`・`*.ts`ソース・
  開発用`node_modules`（vitest等）が含まれないことを確認する

## タスク

- [x] T1: `vscode-extension/scripts/prepare-server.mjs`を新規作成する
      （`electron/scripts/prepare-app.mjs`を土台に、出力先を`server-stage/`へ）。
      実際に実行し、生成物から`node`で直接サーバーを起動してhealthzを確認する
      対象: 新規（参照: `electron/scripts/prepare-app.mjs`全体）
      依存: なし
      AC: なし
- [x] T2: `extension.ts`の`resolveRoot`をdev/packaged分岐に直す
      （`context.extensionMode`で判定。packaged側は`server-stage/`配下を指す）。
      単体テストを書く
      対象: `vscode-extension/src/extension.ts`の`resolveRoot`
      依存: T1
      AC: なし
- [x] T3: `.vscodeignore`・`package.json`の配布向けフィールドを整え、
      実際に`npx @vscode/vsce package`で`.vsix`を生成する。生成物の中身を検査する
      対象: `vscode-extension/.vscodeignore`（新規）・`vscode-extension/package.json`
      依存: T1, T2
      AC: なし
- [x] T4: `prepare-server.mjs`と`resolveServerPaths`が独立に決め打ちしている
      `server-stage/`のレイアウト（`packages/web-ui/dist`・`node_modules/@ts5250/server/dist/main.js`）
      の対応関係をテストで固定する（review round1指摘対応。`[conv:paired-artifact-sync!]`）
      対象: `vscode-extension/test/serverStageLayout.test.ts`（新規）
      依存: T1, T2
      AC: なし
