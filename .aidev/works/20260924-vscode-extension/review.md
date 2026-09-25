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

## 結論（ラウンド1）

指摘なし（must/should/nit いずれも0件）。残る唯一の既知の制約
（VSCode拡張ホストでの実地動作確認）はdeliverのPR本文「既知の制約」に引き継ぐ。

## ラウンド2（deliver後・利用者のWindows実機検証で見つかった診断出力欠陥）

`decisions.md` D3。差分は`serviceManager.ts`（`onChildOutput`をspawn直後から配線・
失敗経路で子をkill）・`extension.ts`（配線の移設）・関連テスト。

- **要件適合**: この欠陥自体はrequirements/design/ACの対象外（診断出力の欠落という
  実装上のバグ）。`aidev coverage`の被覆に変化なし（AC追加なし、`AC: なし`扱い）。
  修正が「利用者が実際に困っていた症状」に直接対応しているかを見た——出力パネルに
  何も出ないという報告は、まさに`onChildOutput`の配線タイミングのバグで説明が付き、
  修正後は成否に関わらず出力が流れる。**価値適合は満たしている**。
- **正確性**: `Promise.race`の負けた側（`spawnError`）が後から解決してもこの変更の
  範囲では未処理rejectionを生まない（`child.once("error", ...)`は1回限りのlistenerで、
  raceの外側では誰も観測しないが、これは今回の変更前から存在する構造であり、
  新規に持ち込んだものではない。範囲外として記録に留める・追わない）。
- **規約適合**: コメントは「なぜ」（旧経路が失敗時に出力を失っていた理由・Windowsの
  実機報告が発端であること）を書いており、AGENTS.mdの方針に沿う。`console.*`は
  使っていない（eslint 0 errors）。
- **保守性**: `onChildOutput`は`ServiceManagerOptions`の他の注入可能フィールド
  （`spawnServer`/`checkHealth`/`now`）と同じパターンで追加されており、一貫している。
- **見つけて直した副次的な問題**: 修正の適用対象であるテストファイル自体に、
  本物のPID 1へSIGTERMを送りかねない箇所が2箇所（1箇所は今回の変更で新たに
  危険になったもの、もう1箇所は既存コードの`release()`経路で元から存在したもの）
  あり、taskcheckの段階で見つけて`process.kill`のモックを追加して直した
  （`decisions.md` D3）。

指摘なし（must/should/nit いずれも0件）。

## ラウンド3（deliver後・利用者のWindows実機検証で見つかった`globalStorageUri`未作成の修正）

`decisions.md` D4。差分は`extension.ts`（`activate()`冒頭で`mkdirSync`）・関連テスト1件。

- **要件適合**: このAC対象外の実装バグ修正（`AC: なし`扱い）。`aidev coverage`の被覆に
  変化なし。
- **価値適合**: 利用者が実際に踏んだ「初回インストール直後に起動できない」という
  症状に直接対応している。修正は実プロセスでの再現・解消確認を伴う（`test-result.md`
  ラウンド3）——推測ではなく実機の報告と一致するエラーを再現してから直している。
- **正確性**: `mkdirSync(dir, {recursive:true})`は既に存在するディレクトリに対しても
  安全（EEXISTをrecursive指定で吸収する）。複数ウィンドウが同時に`activate()`しても
  競合しない（Node/OSのmkdir再帰実装が対応）。
- **規約適合**: コメントは「なぜ」（`globalStorageUri`が物理的に存在する保証が無いこと・
  実機で踏んだ経緯）を書いている。`console.*`未使用（eslint 0 errors）。
- **保守性**: `packages/server`側（共有コード）を個別に直す代替案を検討し、
  影響範囲の小ささを理由に見送ったことを`decisions.md`に残している
  （`ServiceManager.writeLock()`が既に同種の`mkdirSync`パターンを持っており、
  一貫した書き方）。

指摘なし（must/should/nit いずれも0件）。

## ラウンド4（deliver後・利用者のWindows実機検証で見つかった診断ログ欠落の修正）

`decisions.md` D5。差分は`packages/tn5250/src/session/session.ts`（`this.warn`の1行追加）・
`packages/tn5250/test/startup-reject.test.ts`（`fakeTransport`拡張＋テスト1件）。
coding工程で`cross`のtaskcheckラウンド上限（2/2）に達していたため、独立点検はこのreview工程が
初めて（`aidev-40-coding`手順5の指示どおり）。

- **要件適合**: AC対象外の診断ログ追加（`AC: なし`扱い）。被覆に変化なし。
- **価値適合**: 利用者が実際に踏んだ「I902（起動成功）の直後に接続が切れ、理由が
  どこにも見えない」という状況に直接対応している。
- **正確性**: `reason`（`telnet.onClose`から渡る文字列）の出所を`packages/tn5250/src/
  transport/tcp.ts`まで辿り、`"socket closed"`・`"closed by client"`等の固定文言であって
  資格情報等の機微情報を含まないことを確認した（AGENTS.md「セキュリティ」——ログに
  秘密を出さない、に抵触しない）。`this.warn`呼び出しは`reject`の**前**に置かれており、
  例外的な順序の問題（reject後にwarnが呼ばれず記録が欠ける等）は無い。
- **規約適合**: コメントは「なぜ」（監査ログ・web-ui双方が理由を捨てる経路であること・
  実機報告の経緯）を書いている。既存の隣接する分岐（8902の聞き直し・起動応答の失敗）は
  元から`this.warn`を呼んでおり、**今回追加した箇所だけが対称性を欠いていた**という
  診断も`decisions.md`に残している。
- **保守性**: `fakeTransport`への`closeWith`追加は既存の`onClose: () => {}`（無視するだけの
  スタブ）を実際に機能させる形へ拡張しており、他のテストの挙動は変えない
  （既存テストは`onClose`を一切参照していないため無害な拡張）。`packages/tn5250`
  全体（894件）を実行しgreenを確認済み。
- **検討して見送った代替案の扱い**: `audit.ts`・`opMessages.ts`側の変更は`decisions.md`に
  却下理由付きで記録されており、スコープを広げていない。

指摘なし（must/should/nit いずれも0件）。

## ラウンド5（deliver後・利用者の要望「表示関連の設定ボタンを上部に」への対応）

`decisions.md` D6。差分は`EmbedApp.vue`（`ViewSettingsMenu`追加）・`App.vue`
（`REPORT_VIEW_KEYS`を共有定数へ差し替え）・`viewSettings.ts`（export追加）。
coding工程で`cross`のtaskcheckラウンド上限（2/2、work全体で共通のためD5時点で
既に到達）に達していたため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外（利用者からの直接の要望への対応）。
  `aidev coverage`の被覆に変化なし。
- **価値適合**: 利用者が明示的に要望した「表示関連の設定ボタンを上部に配置」を、
  既存の`App.vue`にある機能（`ViewSettingsMenu`）と同じ意味・同じ絞り込み方針で
  埋めており、独自の新規UIを作らず**既存の確立したパターンに揃えた**
  （`aidev-15-research`「UIの規範」の精神——確立したパターンがあるなら流用する）。
- **正確性**: `viewMenuTarget`の分岐（emulator＝全項目／printer＝`REPORT_VIEW_KEYS`／
  sql・ifs＝対象外）は`App.vue`の`viewMenuTarget`と1対1で対応しており、
  意味のズレが無いことをコードで突き合わせて確認した。実ブラウザでの確認
  （printer側）でポップオーバーの中身が実際に`REPORT_VIEW_KEYS`どおり
  （SO/SI表示・表示コード・リンク化・フォントのみ）であることも見ている。
- **規約適合**: `REPORT_VIEW_KEYS`の重複排除は`[conv:paired-artifact-sync!]`
  該当（同じ判断を2か所に持っていたのを1箇所へ集約）。コメントで経緯
  （元は`App.vue`ローカル定数だった）を明記している。
- **保守性**: `App.vue`側の変更は純粋な参照先の差し替え（振る舞い不変）で、
  `packages/web-ui`全体のテスト（2669件）で裏付けている。
- **見送った検証**: emulator側のボタン表示は、このセッションの環境から実機ホストへ
  ネットワーク到達できずスクリーンショットで確認できなかった（`test-result.md`
  「未検証の穴」）。printer側（対称な実装）は確認済みで、型検査・既存テストの
  範囲でemulator側も裏付けている——**「未検証の穴」に明記した**（AGENTS.md
  「主張が証拠の範囲を超えない」）。

指摘なし（must/should/nit いずれも0件）。
