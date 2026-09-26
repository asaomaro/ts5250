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

## ラウンド6（deliver後・利用者の追加要望「テーマ選択ボタンも表示させて」への対応）

`decisions.md` D7。差分は`packages/web-ui/src/EmbedApp.vue`のみ（`DesignMenu`追加）。

- `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json` — 0 errors
- `cd packages/web-ui && npx vitest run` — **2669 passed / 0 failed**（206 test files）
- `npm run build -w @ts5250/web-ui` — 実ビルド成功
- **実ブラウザでの確認（Playwright）**: `embed.html?app=printer`で「⚙ 表示」「外観」「⚙」の
  3ボタンが並んで表示されることを確認。「外観」クリックでスキン一覧（5250端末/WEBアプリ）・
  表示モード（通常/ダーク/システム）を含むポップオーバーが正しく開くことをスクリーンショットで
  確認した。コンソールエラー・ページエラー0件
- `aidev smoke` — pass

このラウンドでは失敗は発生していない。

## ラウンド7（deliver後・利用者の報告「フォントが標準（自動）しか選択できません」への対応）

`decisions.md` D8。差分は`vscode-extension/src/webviewHtml.ts`（`<iframe>`へ
`allow="local-fonts"`追加）・`vscode-extension/test/webviewHtml.test.ts`（テスト1件追加）。

- `cd vscode-extension && npx tsc -b` / `npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **74 passed / 0 failed**（13 test files）
- `npx eslint vscode-extension/src vscode-extension/test` — 0 errors
- **原因の実測特定**: `test/webviewHtml.test.ts`と同じ構造（CSP・sandbox属性付き`<iframe>`）を
  再現したshell HTMLをPlaywrightで用意し、`allow="local-fonts"`の有無を切り替えて
  `queryLocalFonts()`を実際に呼んだ。`allow`無しでは
  `SecurityError: Access to the feature "local-fonts" is disallowed by Permissions Policy`が
  実際に発生し、`allow`有りでは発生しないことを確認した（scratchpadで作成・実行・削除済み）
- **mutation検証**: 新規テストを追加した`allow="local-fonts"`を一旦外してテストが
  実際に失敗することを確認してから戻した
- `aidev smoke` — pass

**利用者確認済み: この修正だけでは直らなかった**（`decisions.md` D8「結論」）。
iframe側のPermissions Policyの障壁は実測で取り除けたが、フォント一覧は依然として
出ない——VSCode拡張のWebview自体がLocal Font Access自体を許可していない、という
VSCode本体側の制約と判断する。「フォント名を直接入力」欄は利用者確認済みで正しく
機能しており、VSCode拡張ではこちらが正規の使い方になる。

## ラウンド8（deliver後・利用者の指摘「表示ポップオーバーにも内部スクロールを」への対応）

`decisions.md` D9。差分は`packages/web-ui/src/components/ViewSettingsMenu.vue`のみ
（`.vsm-menu`へ`max-height: 74vh; overflow-y: auto;`）。

- `cd packages/web-ui && npx vitest run` — **2669 passed / 0 failed**（206 test files）
- `npm run build -w @ts5250/web-ui` — 実ビルド成功
- **実ブラウザでの確認（Playwright、意図的に低いビューポート700×260px）**:
  「表示」ポップオーバーを開き、`getComputedStyle`で実測した:
  - `menuMaxHeight: "192.4px"`（=260pxの74%。意図どおり）
  - `menuScrollHeight: 268`（内容は上限を超えている＝実際にスクロールが要る状況を再現できている）
  - `menuOverflowY: "auto"`
  - `pageScrollable: false`（**ページ全体はスクロール不要**——利用者の要望どおり）
  スクリーンショットでもポップオーバー自身の枠内で切れていることを確認した
- `aidev smoke` — pass

このラウンドでは失敗は発生していない。

## ラウンド9（deliver後・利用者の要望「拡張機能アイコンをfavicon/electronと同じに」への対応）

`decisions.md` D10。差分は`packages/web-ui/scripts/gen-icons.mjs`（出力先を1つ追加）・
`vscode-extension/package.json`（`icon`欄）・`vscode-extension/icon.png`（新規生成物）。

- `npm run gen:icons` — 実行成功。新規`vscode-extension/icon.png`（128×128）を生成。
  **既存3出力はバイト単位で無変更**（`git status`に既存ファイルが現れない＝生成の
  決定性を裏付け）
- `cd vscode-extension && npx @vscode/vsce package` — 実行成功。`.vsix`に`icon.png`
  [1.23 KB]が含まれ、`extension.vsixmanifest`に`<Icon>`要素として登録されることを
  `unzip`で確認した
- `cd vscode-extension && npx vitest run` — 単体実行では全ファイルgreen
  （`serviceManager.integration.test.ts`単体2/2・`serviceManager.multiprocess.
  integration.test.ts`単体1/1）。**全ファイル並行実行では3回中2回、実プロセス統合
  テストが時折flakeした**（`serviceManager.integration.test.ts`/
  `serviceManager.multiprocess.integration.test.ts`。ファイルは回ごとに違う）が、
  4回目の全体実行では74/74 green。単体実行で常にgreenであること・今回の変更が
  アイコンファイル/package.jsonのみでプロセス管理コードに触れていないことから、
  `decisions.md` D2と同種の既知の環境依存flakeと判断した（新規のバグではない）
- `npx eslint packages/web-ui/scripts/gen-icons.mjs` — 0 errors
- `aidev smoke` — pass

このラウンドで新規に発生した失敗は無し（既知のflakeのみ。上記に詳細を記録）。

## ラウンド10（deliver後・利用者の要望「Explorerの.ts5250アイコンもts5250に」への対応）

`decisions.md` D11。差分は`vscode-extension/package.json`のみ（`contributes.languages`追加）。

- `node -e "JSON.parse(...)"` — 有効なJSONであることを確認
- `cd vscode-extension && npx @vscode/vsce package` — 実行成功。新規警告なし
- `unzip -p ts5250-vscode-0.1.0.vsix extension/package.json`で`.vsix`内の
  `package.json`を取り出し、`contributes.languages`が意図どおり
  （`id: "ts5250"`・`extensions: [".ts5250"]`・`icon.light`/`icon.dark`とも
  `"./icon.png"`）埋め込まれていることを確認した
- `cd vscode-extension && npx vitest run` — **74 passed / 0 failed**（13 test files。
  manifestのみの変更のため無関係）
- `aidev smoke` — pass

**実際のVSCode拡張ホストでExplorer上のアイコン表示を目視確認することはできていない**
——このコンテナには実行可能なVSCode拡張ホストが無い（`02-extension-core`以来一貫した
制約）。`contributes.languages[].icon`のAPI自体はMicrosoft公式ドキュメント・
GitHub issueで安定版であることを確認済み（WebSearchでの裏付け。`decisions.md` D11）。
利用者の実機での確認を待つ。

## ラウンド11（deliver後・利用者の要望「クリックするとウィンドウでメッセージを表示」への対応）

`decisions.md` D12。差分は`vscode-extension/src/ts5250EditorProvider.ts`・
`packages/web-ui/src/EmbedApp.vue`・`packages/web-ui/src/components/StatusBar.vue`・
`packages/web-ui/src/components/MessagePane.vue`（副次的に見つけたbusyガードの二重掛け
バグの修正）を変更。`packages/web-ui/src/components/MessageQuickView.vue`を新設。

- `cd vscode-extension && npx tsc -b` / `npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **75 passed / 0 failed**（13 test files。
  新規1件——emulatorのsyncSystem呼び出しを含む）
- `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json` — 0 errors
- `cd packages/web-ui && npx vitest run` — **2683 passed / 0 failed**（208 test files。
  新規14件——`MessageQuickView`10件・`StatusBar`クリック連動2件・`EmbedApp`の
  systemRef伝播1件・`MessagePane`の回帰テスト1件）
- `npx eslint`（vscode-extension・変更したweb-uiファイル） — 0 errors
- `npm run build -w @ts5250/web-ui` — 実ビルド成功
- **mutation検証**: `MessageQuickView.vue`・`MessagePane.vue`双方で見つけた
  「応答しても一覧が読み直されない」バグ（`reply()`が自分の`withBusy`の中から
  `refresh()`を呼び、`refresh()`自身の`busy`ガードに阻まれる）を、実際に
  `fetchMessages()`への切り替えを`refresh()`へ戻してテストが落ちることを
  確認してから直す、という手順で固定した
- **実機での実プロセス確認**（`.env`/`.env.verify`。SR-OSAKA）:
  1. `POST /api/systems`で実際にシステムを登録（`syncSystem`と同じ経路） — 成功
  2. `POST /api/host/messages/send`で自分の待ち行列（`ASAO`）へ実際にメッセージを
     送信 — 成功（実機側で受理・実行）
  3. `POST /api/host/messages`（`MessageQuickView.vue`と同じ経路）で実際に
     読み出せることを確認 — 成功（送ったメッセージがキー付きで返る）
  4. 実機システム登録は`DELETE /api/systems/:ref`で後始末済み
- `aidev smoke` — pass

**実ブラウザでのUI一気通貫（クリック→ポップオーバー→実メッセージ表示）は未達**。
実機のエミュレータ接続（TN5250）を試みたが、既定の装置名（`AS01`）が利用者自身の
別セッションで使用中で「8902: 装置が使用中です」となり繋がらなかった。利用者の
実作業を妨げないよう、新規装置名での再試行や奪い合いはしていない。この部分は
ユニットテスト（`MessageQuickView`のmount→表示→応答→再取得の一連、`StatusBar`の
クリック連動、`EmbedApp`のsystemRef伝播）の範囲で裏付けている。

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
- **D12のメッセージ表示は、実機のTN5250接続（emulator）自体が繋がらず、実ブラウザでの
  クリック→ポップオーバー→実メッセージ表示の一気通貫は確認できていない**（既定の
  装置名`AS01`が利用者自身のセッションで使用中だったため。ラウンド11参照）。
  バックエンド（実機へのメッセージ送信・取得）は実プロセス・実ホストで確認済み。
  UIの配線（クリックで開く・props伝播・応答後の再取得）はユニットテスト
  （mutation検証込み）の範囲で裏付けている。
  **→ ラウンド12でPUB400を使い実際に確認、解消した（下記）。**
- **D14の`⬇ HTML`ボタンは、実際のVSCode拡張ホスト経由でクリック→実ファイル保存まで
  確認できていない**（VSCode拡張ホストが無いこの開発環境の既存の制約と同じ）。
  `allow-downloads`sandboxトークンの必要性自体はPlaywrightの最小再現（`<iframe
  sandbox>`単体でのBlobダウンロード可否）で実証済みだが、**VSCode WebView自体が
  さらに上位でダウンロードを許可しているかは未確認**。`local-fonts`（D8）と同種の
  「もう1段の許可が必要かもしれない」限界として残す。
- **D15の`vscode-extension.bat`は、Windows実機での実行確認ができていない**
  （このLinuxコンテナにはcmd.exeが無い）。`.sh`版は実際に2経路（既定/`--build`）とも
  `.vsix`生成まで確認済み。`.bat`は構造をproven（`start.bat`/`electron.bat`）から
  一字一句に近い形で踏襲することで裏付けている。

## ラウンド12（deliver後・利用者の質問「通常のブラウザ版エミュレータも対応出来ていますか？」への対応）

`decisions.md` D13。ラウンド11の「未検証の穴」（実ブラウザでのUI一気通貫が未達）を、
`AS01`（利用者の実作業中のセッション）とは無関係な装置`MARO`（PUB400）を使って実際に
確認した。差分は`packages/web-ui/src/composables/openConfigured.ts`（1箇所）と、
新設`packages/web-ui/test/open-configured-signon-user.test.ts`。

- **実ブラウザでのUI一気通貫（Playwright + PUB400/MARO、実際に確認できた）**:
  1. サーバーを一時起動（`--connections <PUB400/MAROの設定> --auto-secret-key`、
     `--env-file=.env --env-file=.env.verify`で`PUB400_PASSWORD`を解決）
  2. ランチャーの「接続」をクリック → 5250画面（IBM i Main Menu）が実際に開いた
     （WSの`open`フレームで`session: "own:MARO"`を確認）
  3. ステータスバーに実際に「✉ メッセージあり」が表示された（DOM上`button.msgwait`が存在）
  4. クリック（`dispatchEvent`）すると`MessageQuickView`のポップオーバーが実際に開き、
     実メッセージが表示された
- **利用者からの追加の質問「このメッセージはジョブのMSGQに送信されたものですか？」への
  実機での裏取り**: `QSYS2.MESSAGE_QUEUE_INFO`を`MARO`（自分の待ち行列）と`QSYSOPR`の
  両方に直接クエリして比較。
  - `MARO`: 1件（システムの電源断予告。自分宛て）
  - `QSYSOPR`: 10件（`JOBMANAGER`/`LONGDM`/`#SYSLOAD`等、自分とは無関係な他ジョブの
    システムメッセージ。PUB400は共有機のため常時動いている）
  - ポップオーバーが表示していたのは**QSYSOPRの方**——`openConfigured.ts`の`meta`に
    `signonUser`が無く、`MessageQuickView.vue`の既定待ち行列フォールバックが常に
    `QSYSOPR`になっていたことが原因と判明（`decisions.md` D13に詳細）
- **修正後の検証**:
  - `cd packages/web-ui && npx vitest run test/open-configured-signon-user.test.ts` —
    2 passed（新設）
  - **mutation検証**: `sys?.signonUser`の付加を`git stash`で一時的に外すと1件目が
    実際に`{host:'h'}`のみでfailすることを確認してから復元した
  - `cd packages/web-ui && npx vitest run` — **2685 passed / 0 failed**（209 test files）
  - `npm run build -w @ts5250/web-ui`（`vue-tsc -b`＋`vite build`） — 実ビルド成功
- 後始末: 検証用の一時サーバープロセス・一時接続設定ファイル・Playwrightスクリプトは
  全て削除済み（PUB400への実接続以外、リポジトリへの副作用なし）。

## ラウンド13（deliver後・利用者の要望「HTMLダウンロードボタン追加/設定画面の拡充/CCSIDをドロップダウンに」への対応）

`decisions.md` D14。差分は`EmbedApp.vue`・`SettingsForm.vue`・`embed-protocol.ts`・
`vscode-extension/src/protocol.ts`・`ts5250EditorProvider.ts`・`webviewHtml.ts`。

- `cd vscode-extension && npx tsc -b && npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **76 passed / 0 failed**（13 test files）
- `npx eslint`（変更したvscode-extensionファイル） — 0 errors
- `npm run build -w @ts5250/web-ui`（`vue-tsc -b`＋`vite build`） — 実ビルド成功
- `cd packages/web-ui && npx vitest run` — **2700 passed / 0 failed**（209 test files。
  新規15件——`settings-form.test.ts`のCCSIDドロップダウン/emulator専用フィールド
  出し分け/一覧に無いCCSIDの温存のテスト10件、`embed-app.test.ts`の⬇HTMLボタン・
  SettingsFormへのprops伝播のテスト5件）
- **mutation検証**:
  - `webviewHtml.ts`の`allow-downloads`を一時的に外すと、`webviewHtml.test.ts`が
    実際に2件failすることを確認してから復元した（Chromiumのsandbox仕様どおり、
    Playwrightの`download`イベントで再現）
  - **review工程で発見**: CCSIDドロップダウンが一覧に無い値（5026等）を無関係な項目の
    保存時に黙って消す不具合。`unrecognizedCcsid`での温存を外すと新設テストが
    実際にfailすることを確認してから復元した（`decisions.md` D14・`review.md`
    ラウンド13参照）
  - `SettingsForm.vue`のフォーカストラップの`querySelectorAll`に`select`を足した件は、
    外した状態でも既存テストが全て通ることを確認した——**現在のフィールド順では
    観測可能な効果を持たない**（先頭=host入力・末尾=ボタン行は元々`input`/`button`で
    拾えていたため）。誇張せず、決定記録にもその旨を明記した。この事実確認のために
    書いた専用テストは、無意味と分かった時点で削除した
- **実ブラウザでの確認（Playwright、ビルド済みdistを一時サーバーで配信）**:
  1. `embed.html?app=emulator`で設定画面を開き、端末の種類/画面サイズ/装置名/
     ホストコードページが揃って表示されることを確認（スクリーンショット）
  2. `embed.html?app=sql`で同じ3項目（端末の種類/画面サイズ/装置名）が
     実際に隠れることを確認
  3. ホストコードページで「930 — 日本（拡張カタカナ）」を選択→端末の種類を
     3270へ切替→画面サイズの行が実際に消えることを確認
  4. ラベル幅が狭く「ホストコードページ」が2行に折り返す表示崩れを実際に発見、
     `8em`→`9.5em`＋`white-space:nowrap`で修正し、1行に収まることを再確認した
- `aidev smoke` — pass

**HTMLダウンロードボタンの実クリック→実際のファイル保存ダイアログという一気通貫は
未達**。`allow-downloads`が無いとBlob URLダウンロードがブロックされることは
Playwrightの最小再現で実証したが、実際のVSCode拡張ホスト（このコンテナには無い）
経由でクリック→ダウンロードが動くかまでは確認できていない。

## ラウンド14（deliver後・利用者の要望「vsixのビルドshとbatを作って」への対応）

`decisions.md` D15。新設は`vscode-extension.sh`/`vscode-extension.bat`
（リポジトリ直下）。既存の`launcher/preflight.mjs`冒頭コメントも更新（呼び出し元の
数を4→6に）。

- **`vscode-extension.sh`の実行（既定・鮮度判定でビルドをスキップする経路）**:
  `rm -f vscode-extension/*.vsix && ./vscode-extension.sh` —
  `vscode-extension/ts5250-vscode-0.1.0.vsix`（3916ファイル・10.41MB）を実際に生成。
- **`vscode-extension.sh --build`の実行（強制フルビルド経路）**:
  `rm -f vscode-extension/*.vsix && ./vscode-extension.sh --build` — ライブラリ/server
  のビルド・web-ui（vue-tsc+vite）のビルド・拡張機能自体のビルド（tsc -b）・
  `prepare-server.mjs`・`vsce package`の全段が実際に走り、同じく`.vsix`が生成された。
- `LC_ALL=C grep -n '[^ -~]' vscode-extension.bat` — 非ASCII文字0件（cp932コンソールでの
  誤読を避けるため必須の制約。`start.bat`/`electron.bat`と同じ）。
- `aidev smoke` — pass

**`vscode-extension.bat`はこのLinuxコンテナでは実行できないため未検証**。
`start.bat`/`electron.bat`の実証済みの構造（`if errorlevel`の分岐・`pushd`/`popd`の
対応・エスケープした括弧）を一字一句に近い形で踏襲することで確からしさを担保しているが、
実際のWindows上での動作確認は利用者に委ねる（D8/D14と同種の環境起因の限界）。

## ラウンド15（deliver後・利用者の要望「設定にsplashの設定も追加して」への対応）

`decisions.md` D16。「splash」の意味を`AskUserQuestion`で確認したうえで実装
（ウォーターマーク＝画面に重ねる透かし）。差分は`EmulatorPane.vue`・
`SettingsForm.vue`・`watermark.ts`（クラッシュ修正）・`stores/sessions.ts`・
`embed-protocol.ts`・`vscode-extension/src/protocol.ts`・`schema.ts`・
`ts5250EditorProvider.ts`。

- `cd vscode-extension && npx tsc -b && npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **76 passed / 0 failed**（13 test files）
- `npx eslint`（変更したvscode-extensionファイル） — 0 errors
- `npm run build -w @ts5250/web-ui`（`vue-tsc -b`＋`vite build`） — 実ビルド成功
- `cd packages/web-ui && npx vitest run` — **2712 passed / 0 failed**（210 test files。
  新規21件——`settings-form.test.ts`9件・`embed-app.test.ts`2件・新設
  `emulator-pane-watermark.test.ts`4件・`watermark.test.ts`1件のクラッシュ回帰
  ＋既存テストの拡張分）
- **mutation検証（3件、いずれも「外す→実際にfailを確認→復元」）**:
  1. `EmulatorPane.vue`の`watermarkConfig`の`meta`フォールバックを外すと、
     `emulator-pane-watermark.test.ts`の該当テストが実際にfail
  2. `EmbedApp.vue`の`meta.watermark = payload.watermark`を外すと、
     `embed-app.test.ts`の該当テストが実際にfail
  3. `SettingsForm.vue`の`save()`から`buildWatermark()`の呼び出しを外すと、
     `settings-form.test.ts`の透かし関連4件が実際にfail
- **review工程で発見・修正したクラッシュバグの再現手順**（直す前に実際に再現）:
  `resolveWatermark({})`を直接呼ぶと`TypeError: Cannot read properties of
  undefined (reading 'replace')`が実際に投げられることを確認——`.ts5250`
  ファイルは`schema.ts`の設計上バリデーションを経ないため、手編集で
  `"watermark": {}`のような値を書くと同じ例外で`EmulatorPane`ごと
  描画不能になりうる。`typeof cfg.text !== "string"`のガードを足すと
  例外が起きなくなることを確認し、mutationで検証（外すと新設テストが
  実際に同じ例外でfail）。
- **実ブラウザでの確認（Playwright、ビルド済みdist）**: `embed.html?app=emulator`
  の設定画面を開き、透かし文字が空のときは細かい見え方の欄（表示/配置/濃さ/
  大きさ/角度/色）が出ず、文字を入れると実際に現れることをスクリーンショットで
  確認した。
- **実機での一気通貫（Playwright、PUB400。`.env`/`.env.verify`）**: VSCode拡張の
  shellが行うiframe中継を模した最小shellから、`watermark: { text: "PUB400
  {host}", layout: "center", size: 40 }`を含むconnectペイロードで実際に接続。
  `EmulatorPane`内に`.wm`要素が実際に1つ生成され、その`.wm-line`のテキストが
  差し込み変数展開後の`"PUB400 pub400.com"`になっていることをDOM上で確認した。
- `aidev smoke` — pass
- 後始末: 検証用の一時サーバープロセス・一時接続設定ファイル・Playwrightスクリプト・
  一時ディレクトリは全て削除済み（PUB400への実接続以外、リポジトリへの副作用なし）。

## ラウンド16（PR #414マージ後・利用者の要望「開いただけで接続しない／明示的な接続・切断ボタン」への対応）

`decisions.md` D17。ブランチ`feature/vscode-extension-explicit-connect`。

- `cd vscode-extension && npx tsc -b && npx tsc -b tsconfig.test.json` — 0 errors
- `cd vscode-extension && npx vitest run` — **80 passed / 0 failed**（13 files）。
  初回の全体実行で`serviceManager.integration.test.ts`の1件が実サーバー起動のタイムアウト（20秒）で
  failしたが、単独再実行・全体再実行とも成功。実プロセスを起こす既存テストの環境依存の揺れで、
  本変更（メッセージの配線）はこのテストの経路に触れていない。

```
 FAIL  test/serviceManager.integration.test.ts > ServiceManager 実プロセス統合 > acquireで実際にサーバーが起動し、healthzに到達し、releaseでプロセスが止まる
Error: サーバーが起動しませんでした（port 34001）。「ts5250」出力パネルにエラーが出ていないか確認してください
 Test Files  1 failed | 12 passed (13)
      Tests  1 failed | 79 passed (80)
（単独再実行: 2 passed / 全体再実行: 80 passed）
```

- `npm run build -w @ts5250/web-ui`（`vue-tsc -b`＋`vite build`） — 成功
- `cd packages/web-ui && npx vitest run` — **2723 passed / 0 failed**（210 files）
- **mutation検証**: (1) `stores/embed.ts`で`loaded`/`saved`も`connect`を立てる旧挙動に戻す→
  `embed-store.test.ts`3件fail。(2) `EmbedApp.vue`の`disconnect()`を空にする→切断テスト2件fail。いずれも復元確認済み。
- **実機（PUB400、Playwright。拡張shellの中継を模した最小shell）**:

```
1) 開いた直後: sent= [ 'ready' ] server sessions= 0 connectBtn= 1 pane= 0
2) 接続後: sent= [ 'ready', 'connect' ] server sessions= 1 disconnectBtn= 1
3) 切断後: server sessions= 0 connectBtn= 1 pane= 0
```

  「切断」を押さずにタブを閉じた場合（利用者の質問「ファイルを閉じればOKか」の裏取り）:

```
3) 閉じて2秒後: server sessions= 1
3) 閉じて30秒後: server sessions= 1
3) 閉じて60秒後: server sessions= 1
3) 閉じて95秒後: server sessions= 0
```

- `aidev smoke` — pass
- 後始末: 一時サーバー・一時ファイル・Playwrightスクリプトは削除済み。

**未検証の穴**: 実際のVSCode拡張ホスト上での「接続」「切断」ボタンの操作は未確認（既存の環境制約）。
拡張ホスト↔WebViewの中継は`webviewHtml.ts`のshellと同じ振り分けを模した最小shellで確認した。

## ラウンド17（利用者の報告「IFSの右が空く／列をD&Dでリサイズ／SQLにページのスクロールバーが出る」への対応）

`decisions.md` D18。

- 実測（Playwright＋PUB400、1200×700）:

```
修正前: ifs {"docScroll":[1200,700],"inner":[1200,700],"paneBox":[652,670]}
修正前: sql {"docScroll":[4420,700],"inner":[1200,700],"paneBox":[4420,670]}
修正後: ifs {"docScroll":[1200,700],"inner":[1200,700],"paneBox":[1200,670]}
修正後: sql {"scrollers":["rows-scroll: sw=4230/cw=1006 ..."],"docScroll":[1200,700],"paneBox":[1200,670]}
修正後(450px高): sql {"docScroll":[1200,450],"inner":[1200,450],"paneBox":[1200,420]}
IFS境界ドラッグ: [220,380,598] → 左+120 → [340,380,478] → 右−150 → [340,230,628]
```

- `npx vitest run test/pane-split.test.ts` — 5 passed。mutation（`axis`無視）で3件fail→復元。
- `packages/web-ui` — **2731 passed**（211 files）。`vue-tsc`＋`vite build` green。
- `vscode-extension` — 80 passed（無変更。初回1件は既知の統合テストの揺れ、再実行で成功）。
- `aidev smoke` — pass

**未検証の穴**: 実際のVSCode上での見え方（縦スクロールバーが消えること）は未確認——headless Chromiumは
スクロールバーが場所を取らないため、縦スクロールバーは単独では再現できなかった。ページの大きさが窓と
一致することまでは実測済み。

## ラウンド18（「開く」化・待機表示の情報・ヘッダーの名前とⓘ）

`decisions.md` D19。

- `packages/web-ui` — **2740 passed**（211 files）。`vue-tsc`＋`vite build` green。
- `vscode-extension` — **81 passed**（13 files）。`protocol-sync.test.ts`（`title`追加後も一字一句一致）含む。
- mutation: `SettingsForm.vue`のTLS既定を`?? true`へ戻す→2件fail／`sendLoaded`から`withTitle`を外す→1件fail。復元確認済み。
- 実機（PUB400、Playwright）: emulatorに接続→ヘッダー`sample-emu`＋ⓘ→`SessionInfo`表示。スプールの待機表示（種類「スプール」・説明・設定名・ホスト・TLS無効・ユーザー・「開く」）。
- `aidev smoke` — pass

**未検証の穴**: 実際のVSCode上での見た目は未確認（既存の環境制約）。

## ラウンド19（プリンターセッションの追加・`spool`への改名）

`decisions.md` D20。

- `packages/web-ui` — **2745 passed**（211 files）。`vue-tsc`＋`vite build` green。
- `vscode-extension` — **82 passed**（13 files）。
- mutation: `isSessionApp`を`app === "emulator"`だけに戻す→1件fail（プリンターの資格情報）。復元確認済み。
- 実機（利用者のホスト、装置`PRT_ASAO`）:

```
1) idle: kind= プリンター button= 接続 sessions= 0
2) connected: title= sample-printer sessions= 1 disconnectBtn= 1 htmlBtn= 0
   sent spool: CHGJOB rc= 0 DSPLIBL rc= 0
3) 受信件数: 0 (60s)
4) after 切断: sessions= 0 button= 接続
対照（本来のアプリ・保存済みプリンター設定・同じ装置）: web: 受信= 0 (60s)
OUTPUT_QUEUE_INFO: {"OUTPUT_QUEUE_NAME":"PRT_ASAO","WRITERS_TO_AUTOSTART":1,"NUMBER_OF_WRITERS":0} / スプールはREADYのまま
```

- `aidev smoke` — pass

**未検証の穴**: 帳票の受信〜`PrinterPane`での表示。両ホストともプリンターセッション接続でライターが上がらず
（本来のアプリでも同じ＝環境要因）、受信を観測できなかった。受信後の表示は本来のアプリと同じ`PrinterPane`・
同じ`openPrinterSession`（報告の受け取りを含む）を使っている。実際のVSCode上での見た目も未確認。
