# レビュー: VSCode拡張機能によるts5250画面のWebView表示（親・統合review）

`protocol-subtask.md`に従い、単体review（各subtaskで実施済み）では原理的に見えない
**subtask横断の結合**だけを見る。子で見たことは繰り返さない。

## 1. 親の`tasks.md`（割れ目とproducer→consumer契約）

- T1（01-embed-ui）→T2（02-extension-core）: `embed.html`のURL/クエリ/メッセージ契約
  （`embed-protocol.ts`）。T2側は`vscode-extension/src/protocol.ts`として手複製し、
  `protocol-sync.test.ts`で一字一句一致を固定している。**契約は守られている**。
- T2→T3（03-sql-ifs）/T4（04-packaging）: T2が提供する`Ts5250EditorProviderDeps`
  （`acquireService`/`releaseService`/`secretCrypto`）をT3が`syncSystem`/`log`で拡張、
  T4は`resolveServerPaths`でパス解決のみを差し替え。**両者ともT2のインターフェースを
  破壊的に変更していない**（`Ts5250EditorProviderDeps`は拡張のみ、既存フィールドの型は不変）。
- T3とT4は互いに依存しない設計どおり、ファイルの重なりも無い（T3: `systemSync.ts`・
  `ts5250EditorProvider.ts`の`resolvePayload`。T4: `extension.ts`の`resolveServerPaths`・
  `scripts/`・`.vscodeignore`）。

被覆: `aidev coverage` は `ac=14 design=14/14(100%) tasks=14/14(100%) gaps=0`。
分割work のため tasks 承認時点の基準点は無い（`ac_drift`は`-`）が、**現時点のgapが0**。

## 2. 各subtaskの「未検証の穴」の照合

| 穴 | 出所 | 親統合testで閉じたか |
|---|---|---|
| 実機（PUB400等）への実接続 | 01-embed-ui | ✅ 02-extension-coreのAC3実機検証（emulator）＋本review統合testのSQL/IFS/printer実機検証で閉じた |
| VSCode WebView実機でのフォーカス復帰・キー入力 | 01-embed-ui | ❌ 未閉鎖（VSCode拡張ホストが無い。全subtask共通の制約に集約） |
| パッケージ配布時のresolveRoot分岐 | 02-extension-core | ✅ 04-packaging T2で実装・単体テスト。T4で`prepare-server.mjs`との対応関係を固定 |
| 複数ウィンドウを実際に2つ起動しての検証 | 02-extension-core | ✅ 本review統合testで実プロセス2つの競合を新設・確認（レア事象を観測しbacklog送り。`decisions.md` D2） |
| SQL/IFS/プリンターの実機接続確認 | 03-sql-ifs | ✅ 本review統合testで`syncSystem`の`own:<id>`を使い実機3経路（SQL/IFS/spool）を確認 |
| 孤児システムの蓄積 | 03-sql-ifs | ❌ 未検証のまま（design.mdで実害小と判断済みの受容リスク。テストの穴ではなく設計判断） |
| VSCode拡張ホストでの実地動作確認 | 02/03/04共通 | ❌ 未閉鎖（下記「結論」） |
| vsce publish | 04-packaging | 対象外（requirements/design で明示的にスコープ外） |

**どちらでも閉じないものは must** の基準（`aidev-60-review`手順2）に照らすと、
「VSCode拡張ホストでの実地動作確認」1点に収束する。これは**読解でも実行でも閉じられない**
（このコンテナに拡張ホストが存在しない、という環境制約そのものが原因）。
別セッションが対応中であることは全subtaskのtasks.mdに一貫して記録されており、
新規のmust指摘とはしない（既知・記録済み・対応主体が明確なため）。

## 3. 家族全体のdiffの点検（責務の重複・抜け・横断規約の破れ）

- **秘密の扱い**: 平文パスワードはどの層にも保存されない
  （`ExtensionSecretCrypto`＝拡張側、サーバー側`passwordEnc`＝AES-256-GCM）。
  本review統合testで実際に`connections.json`の生ファイルを読み、平文が一度も
  現れないことを実プロセスで確認済み。
- **ログはstderr/OutputChannel経由**。`console.*`は使われていない
  （`npx eslint vscode-extension/src vscode-extension/test` 0 errors。lintがconsole禁止を担保）。
- **パッケージ境界**: `vscode-extension`はnpm workspacesの外（`electron/`と同じ扱い）。
  `@ts5250/*`への依存は`prepare-server.mjs`がdist成果物を実体コピーする方式で、
  シンボリックリンクに依存しない（`electron/scripts/prepare-app.mjs`と同じ判断を踏襲）。
- **命名の一貫性**: `server-stage`という名前が`prepare-server.mjs`・`extension.ts`・
  `.vscodeignore`・`.gitignore`・`test/serverStageLayout.test.ts`の全箇所で統一されている
  （grep で`resolveRoot`の残骸が無いことを確認済み）。
- **重複**: `protocol.ts`（vscode-extension）と`embed-protocol.ts`（web-ui）の手複製は
  `protocol-sync.test.ts`で対応関係を固定。`server-stage/`レイアウトの`prepare-server.mjs`と
  `resolveServerPaths`の手複製は`serverStageLayout.test.ts`で対応関係を固定
  （`.aidev/conventions/paired-artifact-sync.md`。04-packaging review round1の指摘対応）。
  **2つとも同じ手法（ソースを読んでの文字列対応固定）で統一されており、場当たり的ではない**。
- **秘密情報のコミット**: `git status`で新規ファイル一覧を確認——`server-stage/`・`*.vsix`・
  スクラッチ検証スクリプトはいずれも含まれない（scratchpadで作成・実行・削除済み）。
  `.aidev/works/20260924-vscode-extension/test-result.md`に実機のシステム名（`.env.verify`で
  読んでよいと明示された非秘密識別子）以外の秘密は含まれないことをgrepで確認済み。

## 結論

指摘なし（must/should/nit いずれも0件）。残る唯一の既知の制約
（VSCode拡張ホストでの実地動作確認）はdeliverのPR本文「既知の制約」に引き継ぐ。
