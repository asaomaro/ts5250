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

## 未検証の穴（skip / 環境不足）

- **VSCode拡張ホストでの実地動作確認は最後まで未実施**。このコンテナには
  `--extensionDevelopmentPath`/`.vsix`インストールを駆動できるVSCode拡張ホストが無い
  （全subtaskで一貫して記録済みの制約）。`context.extensionMode`の実際の分岐・
  WebViewの実際の表示・設定ボタンのフォーカストラップの実地挙動・実際のキー入力は
  未検証のまま残る。別セッション（VSCode拡張の自動テスト環境）が対応中。
- `vsce publish`（Marketplace公開）は要件で明示的にスコープ外。
