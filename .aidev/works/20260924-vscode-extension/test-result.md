# テスト結果: VSCode拡張機能によるts5250画面のWebView表示（親・統合test）

全4subtask（01-embed-ui / 02-extension-core / 03-sql-ifs / 04-packaging）が個別にreview承認済み。
`protocol-subtask.md`に従い、ここでは**subtask横断の結合**——各subtaskのtest-result.md
「未検証の穴」に残っていたもののうち、親の統合testで閉じられるものを実際に閉じる。

## 実行したもの
- `cd vscode-extension && npx vitest run`（全ファイル並行実行）— **70 passed / 0 failed**（13 test files）。
  同一条件で計7回以上実行し確認（下記「観測されたレア事象」参照）
- `cd vscode-extension && npx tsc -b` / `npx tsc -b tsconfig.test.json` — 0 errors
- `npx eslint vscode-extension/src vscode-extension/test` — 0 errors
- 実機（`.env`/`.env.verify`。system=`AS400_SYSTEM`）への3本の一回限り検証スクリプト
  （scratchpadに作成・実行・確認後に削除。「未検証の穴」を実際に閉じた）

## 親work「リスク/留意点」の消化

`tasks.md`「リスク/留意点」が明示していた3項目を、この統合testで実際に確認した。

### 1. ロックファイル調停プロトコル（複数ウィンドウを模したシナリオ）

`02-extension-core/test-result.md`の「未検証の穴」——`serviceManager.integration.test.ts`の
「2つのウィンドウ」テストは**同一プロセス内**で2つの`ServiceManager`を順に`await`しており、
実プロセス間のファイルI/Oレースにはなっていなかった。

**新設**: `vscode-extension/test/serviceManager.multiprocess.integration.test.ts` ＋
`vscode-extension/test/fixtures/acquire-cli.mjs`（本物の別プロセスとして2つ`spawn`し、
同じロックファイルへ同時に`acquire()`させる）。

- 収束（同じポートへ1つのサーバーに収束する・healthzが通る）は**単体実行で6/6・全体実行で
  複数回中ほぼ毎回成功**することを確認した。
- **レアな競合を1回観測した**（下記「観測されたレア事象」）。設計上の既知のリスクとして
  backlogへ記録した（`session-lifecycle.md`。このworkでは深追いせず、次の work へ送る判断——
  詳細は`decisions.md` D2）。

### 2. SQL/IFSの二重persist（`.ts5250`のpasswordEncを書き換えたらconnections.json側も追随するか）

`03-sql-ifs`では未検証だった項目。**新設**:
`vscode-extension/test/systemSync.password-integration.test.ts`。

- 実際に起動したサーバー ＋ `syncSystem`を2回（パスワードを変えて）呼び、**実際に書かれた
  `connections.json`の生ファイル**を読んで確認した:
  - 1回目のpasswordEncが平文と一致しない（暗号化されている）
  - 2回目で**同じsystem id**のまま`passwordEnc`の値が**変わっている**（追随を確認）
  - ファイルの生テキストに平文（`first-secret-value` / `second-secret-value`）が
    一度も現れないことも確認（秘密が漏れていない）

### 3. 実機接続確認（AC3はemulatorで02-extension-core済み。SQL/IFS/printerは未実施だった）

`03-sql-ifs/test-result.md`「未検証の穴」: 「01-embed-uiで個別に確認済みの経路を再利用している
だけで、このsubtaskでは新たに実機確認していない」。

**実機（`.env.verify`の`AS400_SYSTEM`＝SR-OSAKA、`.env`の`AS400_PASSWORD`）に対し、
`syncSystem`が登録した`own:<id>`参照を使って、実際に動くかを確認した**
（一回限りのscratchpadスクリプト。実行・記録後に削除済み）:

| 経路 | 呼び出し | 結果 |
|---|---|---|
| SQL | `POST /api/host/sql`（`source:{system: own:s-...}`、`SELECT CURRENT_TIMESTAMP ...`） | 200、実際のタイムスタンプ1行を取得 |
| IFS | `POST /api/host/ifs/list`（同じref、`path: $AS400_IFS_DIR`） | 200、20件のエントリを取得 |
| プリンター(スプール表示) | `POST /api/host/spools`（同じref） | 200、5件（`truncated:true`） |

いずれも**`syncSystem`が登録した参照がそのまま実機接続に使える**ことを実プロセス・実ホストで
確認した——`decisions.md` D3（printer/spool routing訂正）の妥当性を実機で裏付けた形になる。

## 受け入れ基準ごとの判定（親work全体）
`aidev coverage`: `ac=14 design=14/14(100%) tasks=14/14(100%) gaps=0`。
各ACの充足は担当subtaskのtest-result.mdに詳細がある。ここでは上記の結合確認で
AC1（複数画面での単一サービス）・AC8（プリンター/SQL/IFS）の実機裏付けを追加した。

## 観測されたレア事象（ロックファイル調停の二重勝者）

`serviceManager.multiprocess.integration.test.ts`を全ファイル並行実行下で連続して回す中、
**1回だけ**、テスト自身のpid追跡では収束を確認できた（assertion通過）のに、テスト終了後に
`ps`で確認すると**追跡していない別のサーバープロセスがport 34000で3分以上生存し、healthzに
応答し続けていた**事象を観測した。

- 単体実行では6/6、全体実行の直近の再実行でも2/3が正常収束・1/3はテスト自身のassertion
  レベルで「2つ生存」を検出して**正しく失敗**した（プロセスリークをテストが検知できている）。
- **1回きりの観測であり、意図的な再現手順を確立できていない**（`AGENTS.md`「1回の観測で
  決めない」により、これを「確定した欠陥の記述」として書くのは避ける）。
- 理論的な機序（未確認）: ロックファイルの調停は「最後に書いた者が勝ち、その後
  自分の書き込みを読み直して上書きされていたら自分を畳む」という**事後検証方式**であり、
  真の排他ロックではない。`[A-write, A-read(自分を見る), B-write, B-read(自分を見る)]`
  という順序が理論上あり得り、双方とも「自分が勝者」と判定して自己修正しない——
  という筋を立てたが、**実プロセスでの意図的な再現には至っていない**（同条件を10回以上
  試したが、この筋を直接証明する再現は得られなかった）。
- **backlogへ記録した**（`.aidev/backlog/session-lifecycle.md`）。単一利用者のローカルツールとしての
  実害は限定的（余分な`node`プロセスが1つ残るのみ。既存の`killByPid`のpid再利用リスクと
  同じ「単一利用者として許容する」設計方針の範囲内）だが、真の相互排他への置き換えは
  今回のwork範囲外として次のworkへ送った（`decisions.md` D2）。

## ラウンド2（deliver後・利用者のWindows実機検証で見つかった診断出力欠陥の修正）

`decisions.md` D3。`ServiceManager.acquire()`が失敗する経路で子プロセスのstdout/stderrが
一切読まれず、診断に一番要る出力が失われていた欠陥を修正。

- `cd vscode-extension && npx tsc -b` / `npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **72 passed / 0 failed**（13 test files。
  70→72。`serviceManager.test.ts`のタイムアウト系テストを1本に統合しつつ
  spawn-error系を1本純増、`extension.test.ts`に`onChildOutput`配線の確認を1本追加）
- `npx eslint vscode-extension/src vscode-extension/test` — 0 errors
- `aidev smoke` — pass
- **副次的な安全確認**: 修正により`acquire()`の失敗経路が新たに`killByPid`（実体は
  `process.kill`）を呼ぶようになったため、既存テストのうち`process.kill`をモックしていない
  ものが本物のシグナルを送ってしまわないか、このコンテナで`ps -p 1`によりPID 1
  （`/sbin/init`）が無事であることを実行前後で確認した（該当テストは全てモックを追加済み）

このラウンドでは失敗は発生していない。

## ラウンド3（deliver後・利用者のWindows実機検証で見つかった`globalStorageUri`未作成の修正）

`decisions.md` D4。ラウンド2の修正で出力パネルに実際のエラーが届いた結果、
`ENOENT: ...\globalStorage\...\.env`（`context.globalStorageUri`のディレクトリが
物理的に存在しなかった）と判明。`extension.ts`の`activate()`冒頭で`mkdirSync`するよう修正。

- **実プロセスでの再現・修正確認**: `node packages/server/dist/main.js`を、親ディレクトリの
  無いパスへ`--secret-key-file`指定して直接起動し、利用者の報告と**一字一句同じ**
  `ENOENT: no such file or directory, open '.../.env'`（`persistKey`起因）を再現した。
  ディレクトリを先に`mkdir -p`してから同じコマンドで起動すると、エラー無く起動することを
  確認した（実プロセス・実ファイルシステムでの検証。推測で直していない）
- `cd vscode-extension && npx tsc -b` / `npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **73 passed / 0 failed**（13 test files。
  `activate()`冒頭で`globalStorageUri`のディレクトリを実際に作ることを確認するテストを追加）
- `npx eslint vscode-extension/src vscode-extension/test` — 0 errors
- `aidev smoke` — pass

このラウンドでは失敗は発生していない。

## ラウンド4（deliver後・利用者のWindows実機検証で見つかった診断ログ欠落の修正）

`decisions.md` D5。差分は`packages/tn5250/src/session/session.ts`（`this.warn`の1行追加）・
`packages/tn5250/test/startup-reject.test.ts`（`fakeTransport`に`closeWith`を追加、
「I902の直後に接続が切れたら...」テストを1件追加）。

- `cd packages/tn5250 && npx tsc -b` — 0 errors
- `cd packages/tn5250 && npx vitest run` — **894 passed / 0 failed**（83 test files。
  新規1件を含め全green）
- `cd packages/tn5250 && npx vitest run test/startup-reject.test.ts` — 22 passed（新規テストの
  単体実行でも確認）
- `npx tsc -b`（root。`packages/server`が`tn5250`に依存するため再ビルドを確認） — 0 errors
- `npx eslint packages/tn5250/src packages/tn5250/test` — 0 errors
- `node vscode-extension/scripts/prepare-server.mjs` → `npx @vscode/vsce package` — 実行成功。
  生成された`.vsix`内の`server-stage/node_modules/@ts5250/tn5250/dist/session/session.js`に
  `closed during negotiation`という文字列が含まれることを`grep`で確認し、
  ビルド成果物に実際に反映されていることを検証した
- `aidev smoke` — pass

**利用者の実機（S7857290）への接続自体は未解決のまま**。このラウンドは「理由が見えるようにする」
診断ログの追加であり、根本原因（なぜ起動成功I902の直後にセッションが切れるか）は
利用者の次の再検証結果を待つ（`decisions.md` D5）。

## ラウンド5（deliver後・利用者の要望「表示関連の設定ボタンを上部に」への対応）

`decisions.md` D6。差分は`packages/web-ui/src/EmbedApp.vue`（`ViewSettingsMenu`追加）・
`packages/web-ui/src/App.vue`（`REPORT_VIEW_KEYS`を共有定数へ差し替え）・
`packages/web-ui/src/stores/viewSettings.ts`（`REPORT_VIEW_KEYS`をexport）。

- `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json` — 0 errors
- `cd packages/web-ui && npx vitest run` — **2669 passed / 0 failed**（206 test files。
  `embed-app.test.ts`の既存8件も引き続きgreen）
- `npm run build -w @ts5250/web-ui` — 実ビルド成功（`dist/`再生成）
- **実ブラウザでの確認（Playwright、`--no-sandbox`のheadless Chromium）**: 実際に
  `packages/server`を起動し、再ビルドした`packages/web-ui/dist`を配信、
  `http://127.0.0.1:<port>/embed.html?app=printer`を開いて確認した:
  1. 接続前（`embedStore.connect`が未設定）はヘッダーに接続設定ボタン（⚙）のみで、
     「⚙ 表示」ボタンは出ない（スクリーンショットで確認）
  2. `postMessage`で`{type:"connect", payload:{app:"printer", systemRef:"own:..."}}`を
     送ると、「⚙ 表示」ボタンが接続設定ボタンの左に並んで表示される（スクリーンショットで確認）
  3. 「⚙ 表示」をクリックするとポップオーバーが開き、`REPORT_VIEW_KEYS`
     （SO/SI表示・表示コード・リンク化・フォント（画面））だけが出て、5250画面専用の
     項目（カーソル・窓等）が出ないことを確認した（スクリーンショットで確認）
  4. コンソールエラー・ページエラーは0件

このラウンドでは失敗は発生していない。

## 未検証の穴（skip / 環境不足）

- **VSCode拡張ホストでの実地動作確認は最後まで未実施**。このコンテナには
  `--extensionDevelopmentPath`/`.vsix`インストールを駆動できるVSCode拡張ホストが無い
  （全subtaskで一貫して記録済みの制約）。`context.extensionMode`の実際の分岐・
  WebViewの実際の表示・設定ボタンのフォーカストラップの実地挙動・実際のキー入力は
  未検証のまま残る。別セッション（VSCode拡張の自動テスト環境）が対応中。
- `vsce publish`（Marketplace公開）は要件で明示的にスコープ外。
- **D6のemulator側「⚙ 表示」ボタンは画面での確認まで至っていない**。このセッションの
  実行環境から実機ホストへネットワーク到達できず（`closed during negotiation: socket closed`）、
  `sessionId`が付いた状態のemulator画面を再現できなかった。printer(スプール表示)側の
  分岐（対称な実装）はスクリーンショットまで確認済み。emulator側は型検査・既存テストの
  範囲で裏付けている。
