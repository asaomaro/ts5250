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

## ラウンド6（deliver後・利用者の追加要望「テーマ選択ボタンも表示させて」への対応）

`decisions.md` D7。差分は`EmbedApp.vue`のみ（`DesignMenu`の追加）。coding工程で`cross`の
taskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外。被覆に変化なし。
- **価値適合**: 利用者の要望に直接対応。`App.vue`のコメント
  （「テーマはここに出さない。アプリ全体の外観が持っている」）を正しく読み、
  「表示」（D6）と「外観」（本ラウンド）が別コンポーネントである既存の設計を
  そのまま踏襲した——利用者の言葉（「テーマ選択」）を字面どおり新規UIとして
  作らず、確立済みの`DesignMenu`を使ったことが正確性の担保になっている。
- **正確性**: `DesignMenu`は無props・`App.vue`と同じ`<DesignMenu />`呼び出しで、
  差分は実質1行。`embed.ts`が要る初期化（`initTheme`/`initSkin`/`initAppearance`）を
  既に全て呼んでいることをコードで確認済み（D6以前から）。
- **保守性**: 新規コード・新規ロジックなし（既存コンポーネントの配線のみ）。

指摘なし（must/should/nit いずれも0件）。

## ラウンド7（deliver後・利用者の報告「フォントが標準（自動）しか選択できません」への対応）

`decisions.md` D8。差分は`webviewHtml.ts`（`<iframe>`へ`allow="local-fonts"`）・
`test/webviewHtml.test.ts`（テスト1件）。coding工程で`cross`のtaskcheckラウンド上限に
達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外。被覆に変化なし。
- **価値適合**: 利用者の報告した症状（フォント一覧が出ない）の実際の原因を、
  推測ではなくPlaywrightでの実測（`SecurityError`の発生/非発生の切り替え）で
  特定してから直している——AGENTS.md「判断の原則」2に忠実。
- **正確性・セキュリティ**: `allow="local-fonts"`は強力な機能への許可だが、
  この`<iframe>`の`src`はCSPの`frame-src`で**拡張自身がspawnしたloopback
  オリジン1つに絞られており**（`design.md`「設計方針5」）、読み込む内容も
  自前のビルド（`embed.html`）——任意の第三者オリジンへ許可を広げるものではない。
  新たな攻撃面を実質的に増やしていないと判断した。
- **規約適合**: コメントで「なぜ」（実測で特定した原因・この修正だけで十分とは
  限らない理由）を明記している。`decisions.md`にも同じ経緯を残し、
  「未確認」の範囲（VSCode拡張ホスト自体の許可）を明示している
  （AGENTS.md「確かめられなかったことは未確認と明記して残す」）。
- **保守性**: 新規テストはmutation検証済み（属性を外すと落ちることを確認）。

指摘なし（must/should/nit いずれも0件）。

## ラウンド8（deliver後・利用者の指摘「表示ポップオーバーにも内部スクロールを」への対応）

`decisions.md` D9。差分は`ViewSettingsMenu.vue`のみ（CSS1箇所）。coding工程で`cross`の
taskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外。被覆に変化なし。
- **価値適合**: 利用者の指摘に直接対応。「外観（`DesignMenu`）は既にできているのに
  表示（`ViewSettingsMenu`）はできていない」という非対称を正確に言い当てており、
  既存の`.dz-menu`の値をそのまま踏襲した対応は妥当。
- **正確性**: 意図的に低いビューポート（700×260px）を使い、ポップオーバーの内容
  （268px）が上限（192.4px）を実際に超える状況を作ったうえで`pageScrollable: false`
  （ページ全体はスクロール不要）を実測している——「直った」の確認が
  「エラーが出ない」ではなく利用者が要求した具体的な性質（ページ全体が
  スクロールしない・ポップオーバー内で完結する）そのものを検証している。
- **規約適合**: `App.vue`/`EmbedApp.vue`共有コンポーネントである旨をコメント・
  `decisions.md`双方に明記——利用者からの「共通部品化しているので自ずと
  対応されるか」という確認にも、実際にファイルを指して回答している。
- **保守性**: 値（`74vh`）を`.dz-menu`から独自に導出せずそのまま踏襲しており、
  2つのポップオーバーの挙動が今後も揃いやすい。

指摘なし（must/should/nit いずれも0件）。

## ラウンド9（deliver後・利用者の要望「拡張機能アイコンをfavicon/electronと同じに」への対応）

`decisions.md` D10。差分は`gen-icons.mjs`（出力先1つ追加）・`vscode-extension/
package.json`（`icon`欄）・`vscode-extension/icon.png`（新規生成物）。coding工程で
`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外。被覆に変化なし。
- **価値適合**: 利用者の要望に文字どおり対応。**新しい絵を作らず既存の唯一の
  定義元（`gen-icons.mjs`）へ素直に乗った**——スクリプト冒頭のコメントが明示する
  設計思想（「バイナリを手で置くと片方だけ古いまま残る」問題）を正しく尊重している。
- **正確性**: 生成した3つの既存出力（favicon.svg/ico・apple-touch-icon.png・
  electron/build/icon.png）が**バイト単位で無変更**であることを実際に確認しており、
  既存の絵に影響していないことを裏付けている。`vsce package`を実行し`.vsix`への
  実際の反映（`icon.png`同梱・`vsixmanifest`の`<Icon>`要素）まで確認済み。
- **正確性（テストのflake）**: 全ファイル並行実行下で実プロセス統合テストが
  時折flakeした事象を、単体実行での確認・変更内容（アイコンファイルのみで
  プロセス管理コードに触れていない）から**新規のバグではないと判断**し、
  その判断根拠を`test-result.md`に残している——「flakeを無視した」のではなく
  「flakeと断定できる根拠を示した」形になっている。
- **規約適合**: サイズ選定（128px。VS Code Marketplaceの推奨に合わせた）の
  根拠をコメント・`decisions.md`双方に明記している。

指摘なし（must/should/nit いずれも0件）。

## ラウンド10（deliver後・利用者の要望「Explorerの.ts5250アイコンもts5250に」への対応）

`decisions.md` D11。差分は`vscode-extension/package.json`のみ（`contributes.languages`追加）。
coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外。被覆に変化なし。
- **価値適合**: 利用者の要望に直接対応。D10（マーケットプレイスのアイコン）とは
  別物（Explorerのファイルアイコン）であることを正しく識別し、正しいAPI
  （`contributes.languages[].icon`）を選んでいる——`contributes.iconThemes`
  （テーマそのものを作る重い手段。利用者にテーマ切り替えを要求する）との違いを
  `decisions.md`に明記し、後者を却下した理由も残している。
- **正確性**: **推測でAPIを実装していない**——WebSearchで公式ドキュメント・
  GitHub issueを確認し、(1) このAPIが「利用者のアイコンテーマがフォールバックする
  ときだけ効く」という正確な効き方、(2) 安定版でありproposed API解除が
  この拡張の`engines.vscode`より十分前であること、の両方を裏付けてから実装している
  （AGENTS.md「判断の原則」2に忠実）。
- **保守性**: 新規の絵・新規ファイルを増やさず、D10で作った`icon.png`をそのまま
  再利用している。文法定義（`grammars`）は追加せず、要望の範囲（アイコン表示）に
  スコープを絞っている。
- **見送った検証**: 実際のVSCode拡張ホストでExplorer上の表示を目視確認することは
  できていない（このコンテナの制約。一貫して記録済み）。`vsce package`での
  manifest埋め込みの確認までで裏付けとしている——**「未検証の穴」に明記した**。

指摘なし（must/should/nit いずれも0件）。

## ラウンド11（deliver後・利用者の要望「クリックするとウィンドウでメッセージを表示」への対応）

`decisions.md` D12。差分は`ts5250EditorProvider.ts`・`EmbedApp.vue`・
`StatusBar.vue`・`MessagePane.vue`（副次的なバグ修正）・新設`MessageQuickView.vue`。
coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview
工程が担う。

- **要件適合**: requirementsのAC対象外（利用者からの直接の要望・追加質問への対応）。
  被覆に変化なし。
- **価値適合**: 単に「機能を足す」のではなく、途中で判明した設計上のトレードオフ
  （直接接続とsystem参照の非互換）を利用者へ明示し、選択を仰いでから実装している
  （`AskUserQuestion`2往復。「システム登録を自動化」の意味・「複数セッションで
  接続が増えるか」を利用者が問い返した実質を反映）。実装前に技術的な裏付け
  （`/api/host/messages`がsystem参照を要求する事実）を確認してから提案しており、
  推測で進めていない。
- **正確性**: **偶然ではなく、`MessageQuickView.vue`のテストを書く過程で実際に
  踏んで見つけた**「応答後に一覧が読み直されない」バグを、mutation検証つきで
  直している。**同じ穴が既存の`MessagePane.vue`にもあることまで見つけて直した**
  ——新機能を作るために既存コードを読んだからこそ見える種類の発見であり、
  見なかったことにせずに直している。`MessagePane.vue`には既存テストが1件も
  無かったため、この修正を固定する最小のテストを新規に追加した。
- **セキュリティ**: emulatorへの`syncSystem`拡張は、既に`printer`/`sql`/`ifs`で
  実機検証済みの経路（パスワードのAES-256-GCM暗号化・`connections.json`への
  保存）をそのまま再利用しており、新しい暗号化ロジックを増やしていない。
  実機での往復（登録・送信・取得・削除）も確認済み。
- **UI規約適合**: `docs/UI-DESIGN.md`「情報ポップオーバー」の構造規約
  （バックドロップ＋`position:absolute`＋`@click.stop`）とD9で確立した
  `max-height:74vh; overflow-y:auto`をそのまま踏襲している。ボタンの意匠も
  `StatusBar.vue`既存の`.fk`系統に揃えている（`docs/UI-DESIGN.md`「ボタン意匠」）。
- **見送った検証の扱い**: 実機のTN5250接続自体が装置の競合（`AS01`が利用者自身の
  セッションで使用中）で確立できず、実ブラウザでのクリック→表示の一気通貫は
  未達だった。**利用者の実作業を妨げてまで奪い合わなかった判断は妥当**
  （`AGENTS.md`の趣旨——実機検証は重要だが、利用者の実運用を犠牲にしてまで
  行うものではない）。バックエンドの実機確認・ユニットテストでの裏付けの範囲を
  「未検証の穴」に正直に書いている。

指摘なし（must/should/nit いずれも0件）。

## ラウンド12（deliver後・利用者の質問「通常のブラウザ版エミュレータも対応出来ていますか？」への対応）

`decisions.md` D13。差分は`packages/web-ui/src/composables/openConfigured.ts`（1箇所）と
新設`packages/web-ui/test/open-configured-signon-user.test.ts`。coding工程で`cross`の
taskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外（D12機能の実地確認・利用者の追加質問への対応）。
  被覆に変化なし。
- **価値適合**: 「対応できているはず」という**コードの読解だけに基づく回答**を、
  実際に実機（PUB400）で動かして検証してから利用者へ伝えている。さらに利用者から
  「このメッセージはジョブのMSGQに送信されたものですか？」と問われた際、
  推測で「はい」と答えず、`QSYS2.MESSAGE_QUEUE_INFO`を`MARO`（自分の待ち行列）と
  `QSYSOPR`の両方に直接クエリして中身を比較し、**実際には違っていた**ことを
  見つけている。AGENTS.md「判断の原則」2.（実機で確定できることは、必ず実機で
  確定する）に沿った振る舞いで、見つかったギャップをその場で流さず、根本原因を
  特定して直している。
- **正確性**: `openConfigured.ts`の`meta`に`signonUser`が欠けていたのは、D12で
  `EmbedApp.vue`（VSCode拡張の直接接続経路）には対応したが、通常のブラウザ版の
  唯一の接続経路（`LauncherPane.vue`/`ServicesPane.vue`が共通で使う
  `openConfigured.ts`）には対応し忘れていた、という**D12自体の実装漏れ**。
  今回のラウンドはそれを実機で発見し直している。`signonUser`は
  `systemsStore.systems`から`s.system`のrefで引く既存フィールドで、他の
  `meta`フィールド（`host`/`terminal`/`vtEncoding`/`deviceName`）と同じ
  「分かるときだけ付与する」パターンに揃えており、型・既存の呼び出し規約を
  破っていない。
- **境界条件**: `srv:`（サーバー設定）システムを一般ユーザーが開く場合は
  `signonUser`がサーバーから返らない（`config-resolver.ts`の`includeSignon`が
  editor限定）ため、その場合は従来どおり`QSYSOPR`へフォールバックする。
  これは今回のスコープでは「直しきれない」ケースとして`decisions.md`に明記して
  おり、黙って見過ごしていない（ブラウザ側に手掛かりが無い以上、これ以上の
  推測はしない、という判断も明記されている）。
- **保守性**: `meta`構築の共通変数`sys`を切り出し、既存の`host`行も同じ変数を
  使うよう揃えている（重複した`find`呼び出しを1回に減らす副次的な整理）。
  `printer`/`vt`/`display`の3経路が同じ`meta`オブジェクトを共有する既存構造を
  変えておらず、影響範囲は`meta`の中身が1フィールド増えるだけに閉じている。
- **検証**: mutation検証済み（`sys?.signonUser`の付加を外すと新設テストの
  1件目が実際にfailすることを確認してから復元）。`packages/web-ui`全体の
  テスト（209ファイル・2685件）green。`vue-tsc`＋`vite build`green。
  実ブラウザでの一気通貫（PUB400/MARO、Playwright）も確認済み——ラウンド11で
  「未検証の穴」だった項目をこのラウンドで解消した。
- **後始末**: 検証に使った一時サーバー・一時接続設定・Playwrightスクリプトは
  作業終了時に削除済み（リポジトリに残留物なし）。

指摘なし（must/should/nit いずれも0件）。

## ラウンド13（deliver後・利用者の要望「HTMLダウンロードボタン追加/設定画面の拡充/CCSIDをドロップダウンに」への対応）

`decisions.md` D14。差分は`EmbedApp.vue`・`SettingsForm.vue`・`embed-protocol.ts`・
`vscode-extension/src/protocol.ts`・`ts5250EditorProvider.ts`・`webviewHtml.ts`。
coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview
工程が担う。

- **要件適合**: requirementsのAC対象外（利用者からの直接の要望3点への対応）。
  被覆に変化なし。
- **価値適合**: 3点とも「言われた通りに足す」で終わらせず、まず既存の事実を調べてから
  実装している——`enhanced`がプロトコル層で既に無視される値だと`query-reply.ts:45`の
  コメントで確認して設定項目から意図的に除外し、`ifsPath`/`sqlInitial`が
  `IfsPane`/`SqlPane`側に受け皿を持たない死んだフィールドだと確認して同じく除外した。
  「動かないのに設定できるように見えるUI」を作らなかった判断が価値に直結している。
  CCSIDのドロップダウン化も、値を当てずっぽうで列挙せず`ConfigCard.vue`が既に使っている
  確立パターン（`hostCodePages.ts`のACS準拠一覧）をそのまま再利用しており、
  当PJの複数箇所でCCSIDの選ばせ方が食い違う事態を避けている。
- **正確性（review工程で見つけて直した指摘）**:
  - **[must→fixed] CCSIDドロップダウンが一覧に無い値（5026/5035等）を黙って消す。**
    `codePageId`が"unset"のまま保存すると`v.ccsid`が付かず、`handleSave`側の
    `else delete next.ccsid`で**ホストコード欄を一切触っていなくても**既存のccsidが
    消える。5026/5035はACSの一覧には無いが`hostCodePages.ts`の既存docコメントが明記する
    とおりSCS/hostserver側では現役の値——手編集や過去の設定で持っている利用者がいれば、
    無関係な項目（ポート等）を変えて保存しただけでデータを失う。`unrecognizedCcsid`で
    「一覧には無いが元は指定されていた値」を保持し、選び直されない限り温存するよう修正。
    mutationで検証済み（修正を外すと新設テストが実際にfailすることを確認してから復元）。
  - フォーカストラップの`querySelectorAll`に`select`を足した件は、mutationで確認した
    結果**現在のフィールド順では観測可能な効果を持たない**（`decisions.md` D14に誇張せず
    記録済み。この事実確認のためだけの専用テストは無意味と分かり削除した）。
- **セキュリティ**: `⬇ HTML`はサーバーへ往復せず、ブラウザ側に既にあるスナップショットを
  ローカルでHTML化するだけ（`App.vue`と同じ既存実装の再利用）。新しい外部入出力面は
  増えていない。`allow-downloads`の追加はsandbox iframeの制約を緩めるが、対象は
  「同一オリジンのBlob URLダウンロード」1点のみで、`sandbox`の他のトークン
  （`allow-popups`/`allow-top-navigation`等）には触れていない。
- **保守性**: `SettingsFormValues`の拡張は`embed-protocol.ts`/`protocol.ts`の両方へ
  同一の差分を適用し、`protocol-sync.test.ts`（型定義部分の一字一句比較）が機械的に
  固定している（`paired-artifact-sync`条項どおり）。CCSID選択肢・画面サイズ選択肢は
  独自定義を追加せず、`hostCodePages.ts`/`screenSizes.ts`の既存カタログをそのまま
  importして使っており、表の複製が生まれていない。
- **検証**: mutation検証2件（`allow-downloads`／CCSID保持）。`vscode-extension`:
  `tsc -b`×2・`vitest run`（76 passed）・eslint 0 errors。`packages/web-ui`:
  `vue-tsc -b`＋`vite build`green・`vitest run`（2699 passed→修正で18件に1件追加）。
  実ブラウザ（Playwright、ビルド済みdist）でemulator/sql両方の設定画面を実際に開き、
  端末の種類/画面サイズ/装置名の出し分け・CCSIDドロップダウンでの930選択・
  端末3270切替時の画面サイズ欄消失をスクリーンショットで確認。ラベル幅不足による
  折り返し崩れも実際に見つけて修正した。
- **未検証のまま残る点**: `⬇ HTML`ボタンの実クリック→実ファイル保存は、実際のVSCode
  拡張ホストが無いこの開発環境では確認できていない（D8の`local-fonts`と同種の限界。
  `test-result.md`に明記済み）。

指摘1件（must、review工程で発見しその場で修正・mutation検証済み）。

## ラウンド14（deliver後・利用者の要望「vsixのビルドshとbatを作って」への対応）

`decisions.md` D15。新設は`vscode-extension.sh`/`vscode-extension.bat`（リポジトリ直下）。
`launcher/preflight.mjs`冒頭コメントも更新。coding工程で`cross`のtaskcheckラウンド
上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外（利用者からの直接の要望への対応）。
  被覆に変化なし。
- **価値適合**: 「言われた通りに新しく書く」前に、既存の`start.sh`/`electron.sh`
  （＋`.bat`対）を実際に読み、**同じ構造の3本目として乗せる**判断をしている。
  車輪の再発明をしなかったことで、Node版チェック・ワークスペース依存の鮮度判定・
  `--build`強制再ビルドという、既に実運用で踏んだ教訓（`start.bat`/`electron.bat`の
  コメントに残る実例）がそのまま今回にも効く。
- **正確性**: 実際に2経路（既定の鮮度判定スキップ／`--build`強制）の両方を
  このセッションで実行し、`vscode-extension/ts5250-vscode-0.1.0.vsix`
  （3916ファイル・10.41MB）の生成を確認している。単に「書いて終わり」にせず、
  動くことを実行で確かめてから承認している。
- **規約適合**: `.bat`は`LC_ALL=C grep -n '[^ -~]'`で非ASCII文字が無いことを確認済み
  （`start.bat`/`electron.bat`冒頭の既存コメントが明記する制約——cp932コンソールでの
  多バイト文字誤読を防ぐため）。
- **保守性**: `launcher/preflight.mjs`冒頭の「4つのランチャー」という古い記述を、
  呼び出し元が実際に6つになった時点で「6つのランチャー」へ更新している——
  記述と実体の食い違いを見つけてその場で直しており、放置していない
  （AGENTS.md「判断の原則」3の精神）。
- **未検証のまま残る点**: `vscode-extension.bat`はこのLinuxコンテナでcmd.exeが
  無いため実行確認ができていない。`start.bat`/`electron.bat`の実証済み構造を
  一字一句に近い形で踏襲することで確からしさを担保しているが、実際のWindows上での
  動作は利用者による確認が必要（`test-result.md`ラウンド14に明記済み）。

指摘なし（must/should/nit いずれも0件）。

## ラウンド15（deliver後・利用者の要望「設定にsplashの設定も追加して」への対応）

`decisions.md` D16。差分は`EmulatorPane.vue`・`SettingsForm.vue`・`watermark.ts`
（クラッシュ修正）・`stores/sessions.ts`・`embed-protocol.ts`・
`vscode-extension/src/protocol.ts`・`schema.ts`・`ts5250EditorProvider.ts`。
coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview
工程が担う。

- **要件適合**: requirementsのAC対象外（利用者からの直接の要望への対応）。
  被覆に変化なし。
- **価値適合**: 「splash」というコードベースに無い言葉を、意味を確認せずには
  実装しなかった（`AskUserQuestion`で確認）。AGENTS.md「判断の原則」2.
  （実機で確定できることは、必ず実機で確定する）と同じ態度を仕様理解にも適用しており、
  誤った機能を作るリスクを実装前に潰している。確認後も「通常版が既に持つ機能」と
  分かった時点で、独自実装ではなく`ConfigCard.vue`の`wmForm`をそのまま移植する
  判断をしており、車輪の再発明も避けている。
- **正確性**: この作業で最も価値があったのは、**実装対象の機能そのものではなく、
  実装の過程で見つけたクラッシュバグ**（`resolveWatermark()`が`cfg.text`の型を
  確かめずに`.replace()`を呼んでいた）。`resolveWatermark`のwatermark.ts自体は
  今回新規に触ったわけではないが、この関数への入力元を初めて「スキーマ検証を経ない
  ファイル」（`.ts5250`）にまで広げたのが今回の変更であり、**その拡張が既存関数の
  暗黙の前提（呼び出し元は必ずzod検証済み）を破ることを見抜いて直している**。
  実際に`resolveWatermark({})`を呼んで`TypeError`を再現してから直しており、
  「型的にはあり得るが実害は無いだろう」で済ませていない。
- **境界のスコープ判断**: `ifsPath`/`sqlInitial`をD14で除外した判断（IfsPane/
  SqlPaneが受け皿を持たない死んだフィールド）と同じ基準で、`enhanced`は今回も
  設定項目に追加していない——一貫した判断基準を保っている。
- **保守性**: `WatermarkValue`をembed-protocol.ts/protocol.tsへインライン定義し、
  `@ts5250/server`の`Watermark`を拡張機能側へimportする経路を作らなかった
  （アーキテクチャ制約——`vscode-extension`は別npmパッケージ——を尊重）。
  `wmForm`/`buildWatermark`/`clamp`のロジックは`ConfigCard.vue`と重複するが、
  **共有可能な置き場が無い**（`ConfigCard.vue`は`PublicSession["watermark"]`
  （サーバー保存の`SessionConfigForm`）を、`SettingsForm.vue`は`WatermarkValue`
  （ファイル保存の`.ts5250`）を扱っており、型も保存先も異なるため共有関数への
  切り出しは無理に一般化するコストの方が高いと判断——`paired-artifact-sync`条項の
  「共有できないときは対応関係をテストで固定する」に該当し、両者とも独立した
  テスト（`watermark.test.ts`のConfigCard側・`settings-form.test.ts`の今回追加分）
  で個別に固定している。
- **検証**: mutation検証3件（`meta`フォールバック／`meta.watermark`配線／
  `save()`のbuildWatermark呼び出し）＋クラッシュ修正の検証（再現→修正→
  mutationで復元確認）。`vscode-extension`・`packages/web-ui`とも全テストgreen
  （2712 passed）。実ブラウザでの設定画面確認、実機（PUB400）での接続→
  DOM上の透かし要素・差し込み変数展開の確認まで完了している。

指摘なし（must/should/nit いずれも0件。coding段階の自己点検で見つけたクラッシュ
バグは、review到達前にこの作業自身の中で発見・修正・検証済みのため、
review指摘としては数えない——protocol.md「8.」の「タスク点検で潰れた欠陥は
ラウンド指摘と母集団が違う」と同じ整理）。

## ラウンド16（PR #414マージ後・利用者の要望「開いただけで接続しない／明示的な接続・切断ボタン」への対応）

`decisions.md` D17。coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合**: requirementsのAC対象外（利用者の直接の要望）。被覆に変化なし。
- **価値適合**: 利用者の質問「切断はファイルを閉じればOKか」に**推測で答えず実測した**（閉じると95秒後まで
  サーバーがセッション＝装置を保持。切断ボタンなら即時解放）。切断ボタンを足す根拠が数値で残っている。
  自動接続の発生源が`ready`だけでなく**保存後の`saved`にもあった**ことまで突き止めて両方を塞いでいる。
- **正確性**:
  - [must][conv:-] `packages/web-ui/src/EmbedApp.vue` 接続失敗（`connectError`）・保存失敗（`embedStore.error`）の
    ときエラー文だけを別分岐で出し、「接続」ボタンが消えていた——失敗後に押し直す手段が無く、ファイルを
    開き直すしかなかった（以前は保存のたびの自動再接続がこの穴を隠していた）。 / 対応: エラーを待機表示の
    中に出し、ボタンと同居させた。回帰テスト2件（接続失敗・保存失敗でもボタンが出る）を追加し、旧レイアウトに
    戻すとfailすることをmutationで確認。
  - `buildDisplayPayload`がemulator以外のuser/passwordを剥離している（`syncSystem`経路を通らなくなったぶん
    ここで剥がさないと平文がWebViewへ漏れる）——taskcheck T2の不変条件を新経路でも維持していることを
    テスト（`loaded`/`saved`の両方）で確認。
  - 切断→再接続の往復（`sessionId`が空になった後に次の`connect`で開き直せる）をテストで追加確認。
- **保守性**: プロトコルの追加は2つの複製へ同一差分で入れ、`protocol-sync.test.ts`で固定
  （`paired-artifact-sync`）。`parseOrInvalid`で`sendLoaded`/`sendConnect`の重複を1か所にまとめた。
- **検証**: `vscode-extension` 80 passed・`packages/web-ui` 2726 passed・実機（PUB400）で
  開く→0／接続→1／切断→即0を確認。

指摘1件（must、この工程で修正・mutation検証済み）。

## ラウンド17（利用者の報告「IFSの右が空く／列をD&Dでリサイズ／SQLにページのスクロールバーが出る」への対応）

`decisions.md` D18。coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **要件適合 / 価値適合**: 報告の2症状（IFSの右の空き・SQLのページ横スクロール）を**同じ1つの原因**
  （`.embed-body`の行flexの子に`flex:1; min-width:0`が無い）まで実測で絞り込み、1か所で直している。
  リサイズは新しい部品を作らず、既存の`usePaneSplit`/`PaneSplitter`に左右向きを足した——SQL／スプールの
  境界と掴み方・キー操作が揃う。IfsPaneは本来のアプリと共用なので、そちらでも境界ドラッグが使える。
- **正確性（この工程で見つけて直した指摘）**:
  - [should][conv:-] `packages/web-ui/src/components/PaneSplitter.vue` 縦の境界に`margin: 0 -4px`を付けて
    隣の列へ食い込ませていた——9pxの掴み手が隣の列の縦スクロールバー（フォルダ一覧は長く、実際にスクロール
    バーが出る）を覆い、スクロールバーを掴めなくなる。 / 対応: 負のmarginをやめ、境界が自分の9pxを取る。
  - [should][conv:-] `packages/web-ui/src/components/IfsPane.vue` 列を`flex:none`＋px幅にしたため、狭い窓や
    大きくドラッグした後に列の合計がペインをはみ出し、今回直したばかりのページ横スクロールを再発させうる。
    また既定値（220+380）のままでは狭い窓で表示がほぼ0幅に潰れる（修正前は一覧と表示が半分ずつ）。 /
    対応: 一覧側を`flex: 0 1 auto`（縮めてよい）＋最小幅、表示に`min-width:160px`。実測: 既定で
    1200px→[220,380,582]・800px→[220,380,182]・600px→[155,267,160]、最大までドラッグ後に600pxへ
    狭めても`scrollWidth`＝窓幅（はみ出さない）。
- **規約適合**: 実測値を記録に残した（`measurement-sanity`）。mutationで`axis`無視を検出できることを確認し、
  すり抜けたキーボードのテストを直した（`verify-by-mutation`）。
- **検証**: `packages/web-ui` 2731 passed・実機でのドラッグと幅の実測（D18）。

指摘2件（should、この工程で修正・実測済み）。

## ラウンド18（「開く」化・待機表示の情報・ヘッダーの名前とⓘ）

`decisions.md` D19。coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **価値適合**: 「切断が不要なものはあるか」に推測で答えず、ホストサーバー各経路の接続の張り方をコードで確かめて
  から（D19背景）、利用者の判断を仰いでいる。「開く」を残す理由（無くすとD17の要望が再発する）も利用者に示した。
- **正確性**: 待機表示のTLSを実装するためにサーバーの既定を確かめた結果、**設定フォームが保存のたびにTLSを
  黙って有効化する既存の不具合**を見つけて直した（本来のアプリの既存編集と同じ`?? false`）。ⓘは本来のアプリと
  同じ`SessionInfo`を使い、表示用の`meta`を足すだけに留めた（別実装にしない）。
- **保守性**: 機能の説明文を`features.ts`へ切り出し、ランチャーと待機表示で共有（`paired-artifact-sync`）。
  プロトコルの`title`追加は2つの複製へ同一差分（同期テストで固定）。未使用になった`isActive`は削除した。
- **検証**: 上記テスト結果・mutation・実機スクリーンショット。

指摘なし（must/should/nit いずれも0件。TLSの既定値の不具合は実装中に見つけてこの作業の中で修正済み）。

## ラウンド19（プリンターセッションの追加・`spool`への改名）

`decisions.md` D20。coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **価値適合**: `printer`がスプール表示を指す既存の食い違いを放置して別名を足すのではなく、利用者に判断を仰いで
  本来のアプリの呼び名に揃えた（互換の影響は未公開ゆえ手元のファイルだけ、と根拠付きで提示）。
- **正確性**: 資格情報の剥離判定を「emulatorか」から「セッションか」へ変えないと、プリンターが直接接続に要る
  user/passwordを受け取れず開けない——ここを見落とさずテスト・mutationで固定した。一方で剥離の緩めすぎ
  （spoolへ平文が漏れる）も同じテストで塞いでいる。
- **検証の誠実さ**: 帳票受信を観測できなかったとき、VSCode側の不具合と決めつけず**本来のアプリで対照実験**を行い、
  同じ結果（受信0）であることを確かめてから環境要因と判断した。受信〜表示は「未検証の穴」として明記した。
  実機に作ったテスト用スプールは、自分が作った5件だけを日時で絞り込んで確認してから削除した。
  また、以前の検証（D13）で停止し損ねていた一時サーバー（12時間稼働）を見つけて停止した。
- **保守性**: 表示は本来のアプリと同じ`openPrinterSession`/`PrinterPane`/`SessionInfo`を使い、別実装を作っていない。

指摘なし（must/should/nit いずれも0件）。

## ラウンド20（スプールが「5250端末」と名乗る不具合・前のビルドのサーバー再利用）

`decisions.md` D21。coding工程で`cross`のtaskcheckラウンド上限に達しているため、独立点検はこのreview工程が担う。

- **前ラウンドの指摘の由来**: [must][conv:paired-artifact-sync!] D20（前ラウンド）で種別`spool`を足したとき、
  4か所に書き写した一覧のうち`embed.ts`だけ直し漏れた——`paired-artifact-sync`条項が防ごうとしている
  「片方だけ直る」そのもの。同じ不変条件を支える項を列挙し（型・`schema.ts`・`stores/embed.ts`・`embed.ts`）、
  写しを無くして1か所（`EMBED_APP_KINDS`）から参照させ、全要素で回るテストで固定した。
- **正確性**: emulatorの症状は再現しなかったことを明記し、推測を事実として書いていない。確かめられた欠陥
  （ビルドを見ない再利用）を塞ぎ、「それが原因だったかは未確認」と分けて記録した。ビルドが違うときに古いサーバーを
  **止めてから**起動する（止めないと孤児になる）ことまで考えてある。`process.kill`はテストでモックしている。
- **検証**: 5種類すべての待機表示を実画面で確認。mutation 2件。

指摘1件（must。前ラウンドの実装漏れ。この工程で修正・検証済み）。

## ラウンド21（「接続中…」が左端に出る）

`decisions.md` D22。D18の規則（`.embed-body > *`）の影響範囲を全部洗った: 直下の子はペイン4種・REST用の`template`の中身
（ペイン）・`.status`（接続中）・`.status.idle`（待機カード）。文言は`.status`の2つだけで、どちらも今回の打ち消しに入る。
指摘なし。

## ラウンド22（設定を待機画面に置き、自動保存・即時反映する）

`decisions.md` D23。

- **要件適合**: (1)自動保存=`document.save()`まで行う (2)即時反映=初期値を`loaded`だけにし、外の書き換えも
  `onDidChangeTextDocument`で送る (3)ヘッダーの⚙を廃止し待機画面に欄を置く (4)ポップアップを廃止——4点とも満たす。
  spool/sql/ifsは開いた後に設定へ戻る手段が無くなるので「閉じる」を足した（要望の帰結として必要）。
- **正確性**: 自動保存で新たに生まれる競合を列挙して塞いだ——保存と接続の順序（キュー）・自己書き込みの通知で
  フォームが作り直される（キュー内比較）・外の書き換えと間引き中の入力の衝突（捨てる）・打ちかけの不正ポート・
  読めないファイルの上書き。それぞれテストとmutationで固定。
- **保守性**: 古いコメント（「設定ボタンでの再接続」「設定ボタンから埋める」）を今の画面に合わせて直した。
  `SettingsForm`から不要になったフォーカストラップ等は削除（死んだコードを残さない）。
- **UI**: ボタンを欄の上へ・カード幅の循環%を固定幅に——実画面で見つけて直した（test-result）。

指摘なし（実画面で見つけた2件はこの工程の前に直した）。

## ラウンド23（設定の欄を横に並べる・自動保存の状態表示）

`decisions.md` D24。

- **要件適合**: 「保存されるのか」は答え（編集のたびに自動保存）を画面にも出した。横方向の活用は、emulatorが1000×600で
  スクロール無しに収まることを実測した。
- **正確性**: 保存状態の表示は、応答待ちの間の次の入力で「保存済み」と誤表示しない（テストとmutationで固定）。
- **保守性**: 列数を`settingsLayout.ts`の1つの表にし、フォームとカード幅の両方が読む（`[conv:paired-artifact-sync]`
  ——対になる2か所に同じ値を書かない）。

指摘なし。

## ラウンド24（マークをクラシックの配色に）

`decisions.md` D25。要望の「漏れなく」は、`git ls-files`の画像と参照をすべて洗い出して確かめた（6出力。画面内の複製・theme-color・マニフェストは無い）。
生成経路が2本あった`icon.ico`は1本に寄せ、作り直し忘れはテストで落とすようにした。指摘なし。

## ラウンド25（字形を大文字の`TS`に）

`decisions.md` D26。出力は1つの定義から全部作り直されている（スタンプとテストで確認）。字形の説明コメント（`ts`→`TS`）も直した。指摘なし。

## ラウンド26（`S`の継ぎ目・傾き・上半分の幅）

`decisions.md` D27。SVGの輪郭とラスタの判定は同じ定数（半径・切る x）から作るので形がずれない（1024pxのPNGとSVGを並べて確認）。
不要になった線のSVG出力（`arc`）は消した。指摘なし。

## ラウンド27（`TS`を書体の字形に）

`decisions.md` D28。借りた字形の出所・ライセンス（OFL 1.1）・取り方（縮尺・配置）をコードのコメントに残した。使われなくなった円弧・切り口の
コードは消した。SVGとラスタは同じ`GLYPHS`から作るので形がずれない。指摘なし。

## ラウンド28（ブロックカーソルで`S`を反転表示。D30で破棄）

`decisions.md` D29。■と`S`の抜きはラスタ（`sample`）とSVG（描く順序）で同じ定義から作る。使われなくなった下線の透明度（`CURSOR_ALPHA`）は消した。
`T`の色が図案の読み取りであることは記録に残した。指摘なし。

## ラウンド29（`T`にブロックカーソルを重ねる）

`decisions.md` D30。■・字・下線はラスタ（`sample`）とSVG（描く順序）で同じ定義から作る。色は`styles.css`のクラシックの値とテストで突き合わせる。指摘なし。

## ラウンド30（下線の色・形と■との接し方）

`decisions.md` D31。■は伸ばさず配置で接している（高さ36のまま）。使われなくなった下線の透明度（`UNDERLINE_ALPHA`）は消した。指摘なし。

## ラウンド31（種別ごとの拡張子・保存ボタン）

`decisions.md` D32 / D33。

- **要件適合**: 空ファイル→画面で設定（拡張子で種別）・入力で保存しない・保存ボタン・接続/開くは保存してから、の4点を満たす。
- **正確性**: 拡張子の表と`package.json`はテストで突き合わせる（静的JSONは表を参照できない）。打ちかけの不正値で保存・接続できないようにした。
  `.gitignore`に新しい拡張子を足し忘れると暗号文を含む設定がコミットされうる——足した（ローカルのサンプルで`git check-ignore`を確認）。
- **保守性**: 拡張機能・Web UIのコメントとREADMEの`.ts5250`を新しい拡張子・「設定ファイル」に直した。

指摘なし。
