# 決定記録

## D1: 三層判定（対象外 / light / full）

- **背景**: `aidev-00-start`手順0の三層判定。VSCode拡張機能の新規開発という要望を受けた。
- **決定**: **full**として進める。
- **理由・代替案**: light の4条件（振る舞い不変・影響が局所・PJの確立パターンをなぞるだけ・
  判断を要さない）のいずれも満たさない——新規サブシステム（VSCode拡張）を立ち上げ、
  複数パッケージ（`vscode-extension/`新設・`packages/server`の起動方式・`packages/web-ui`の
  埋め込みモード）にまたがり、UI/UX・セキュリティ・プロセスライフサイクルの新規アーキテクチャ
  判断を伴う。「迷ったらfull」の原則にも合致し、そもそも迷う要素がない規模。
- **影響**: requirements→design→tasksをフルで実施する。

## D2: パスワードの保存方式（利用者の初期案を修正）

- **背景**: requirements工程の質問で、利用者は当初「`.ts5250`ファイルにパスワードを平文で
  記述し、コミットしない運用で回避する」を選択した。しかしAGENTS.md「セキュリティ」節・
  「アカウント・権限設計」節は、`profiles.json`/`connections.json`について
  「パスワードは平文で保存しない」「平文`password`はプロファイルで廃止（読み込み時に
  明示エラー）」と明記しており、これは過去に意図的に下された決定である。
  「コミットしない」は利用者の運用に依存する弱い保証で、`.gitignore`漏れ・誤addの実例が
  AGENTS.md自身に記載されている（「秘密を保存する置き場を新設したら、その場で`.gitignore`に
  足す」「足し忘れは『動くので気づけない』種類の漏れ」）。
- **決定**: 平文案をそのまま採用せず、規約との矛盾を利用者へ明示的に提示したうえで再確認を取り、
  **既存の`signon.passwordEnc`と同じ暗号化フィールド方式**を採用する結論に至った。
- **理由・代替案**: 検討した代替案は (a) 暗号化フィールド（採用）、(b) `passwordEnv`環境変数参照、
  (c) 平文を例外として明示的に許容、の3つ。既存の資産（`SecretCrypto`・AES-256-GCM）を
  そのまま転用でき、利用者が設定ボタンから直接パスワードを入力するUXとも相性が良いため
  暗号化フィールドを採用。master keyの保存場所（VSCode SecretStorage等）は未確定のまま
  design以降へ送った。
- **影響**: `requirements.md`のAC7/AC8・非機能要件・US4はこの決定を前提に書かれている。
  design工程でmaster keyの置き場所と、暗号化フィールドの具体的なJSONキー名を確定する。

## D3: 「プリンター/スプール表示」の接続経路の訂正（design承認後に発覚）

- **背景**: design.md承認時点では「エミュレータ/プリンター」を`WsOpen`直接接続グループ、
  「SQL/IFS」を`system`参照必須グループとしていた（`ws-messages.ts:14-89`の`WsOpen`に
  `kind: "printer"`があったため、要望文の「スプール表示」をこの`WsOpen`の`printer`種別と
  同一視した）。tasks工程（01-embed-uiのtasks分解に着手した際）で実装対象の
  `SpoolPane.vue`を実際に読んだところ、「スプール表示」機能は`WsOpen`ではなく
  `/api/host/spools`等のREST APIを`source: { system: props.system }`で呼ぶ
  （`SpoolPane.vue:130,162,228,272`）——SQL/IFSと同じ`sourceSchema`
  （`host-api.ts:19-27`）を経由する経路だと判明した。`WsOpen`の`kind: "printer"`は
  「プリンターセッション（TN5250Eの印刷ジョブを受け取るライブ接続）」であり、
  要望の「スプール表示（既存スプールファイルの閲覧）」とは**別機能**だった。
- **決定**: design.md「設計方針3」・architecture.md・親`tasks.md`のT2/T3を訂正する。
  「プリンター/スプール表示」は`system`参照必須グループ（`03-sql-ifs`サブタスクが担当）に
  移す。`02-extension-core`サブタスクの担当範囲は**エミュレータのみ**に狭める。
  `03-sql-ifs`のフォルダ名（既に`aidev new`で作成済み）はそのまま維持し、担当範囲の
  記述だけをtasks.md内で明示的に訂正する（フォルダのリネームによる混乱を避ける）。
- **理由・代替案**: AGENTS.md「判断の原則」3（新しい事実が過去の決定と矛盾したら過去の決定を
  疑い、破棄する）に従い、承認済みのdesign/architecture/親tasksであっても事実誤認は
  その場で訂正する。代替案（`03-sql-ifs`をリネームして`03-rest-apps`等にする）は、
  既にCLIで作成済みのフォルダ・`dependsOn`参照を壊すコストに見合わないため見送った。
- **影響**: `02-extension-core`のスコープが縮小（エミュレータのみ）、`03-sql-ifs`の
  スコープが拡大（プリンター/スプール表示を追加で担当）。両subtask自身の`tasks.md`は
  まだ書かれていないため、この訂正後の正しい認識で最初から書く。

## D4: `mode`をinteractiveからautonomousへ切替（利用者指示）

- **背景**: 01-embed-uiのtasks承認ゲート直前で、利用者から「autonomousで進めて」との
  明示指示があった。
- **決定**: 親work（`20260924-vscode-extension`）と全4subtask（`01-embed-ui`/
  `02-extension-core`/`03-sql-ifs`/`04-packaging`）の`state.yml`の`mode`を
  `interactive`から`autonomous`へ変更した（`humanGates`は空のまま＝完全自律）。
  `aidev` CLIに`mode`切替コマンドが無いため、`state.yml`を直接編集した
  （`approved`/`current`と異なり`mode`はCLIの排他更新経路の対象外——冪等な静的設定であり
  イベント履歴を持たないため）。
- **理由・代替案**: `protocol-autonomous.md`に従い、以降は各工程末の承認ゲートを自動承認する。
  ただし方針選択を伴う工程（design/architecture/tasks。今回はいずれも既に承認済みか、
  残りのsubtaskで新たに発生する）は「方針をdecisions.mdに書いてから進む」という事前承認の
  作法を維持する。test/deliverの安全弁（testを硬いゲートにする・PRで停止しauto-mergeしない・
  maxSendBacks到達でdebugへ委譲）はprotocol-autonomous.mdの規定どおり適用する。
- **影響**: 以降の工程終了は人間の確認を待たずに進む。PR作成（またはPRが作れない環境では
  作業ブランチへのコミット）で停止し、そこで利用者への報告を行う。

## D2: ロックファイル調停の「二重勝者」レア事象は、このworkでは深追いせず backlog へ送る

- **背景**: 親の統合test（`serviceManager.multiprocess.integration.test.ts`。本物の別々の
  OSプロセスとして2つ`acquire()`を競合させる）で、全ファイル並行実行下で1回だけ、
  どちらのプロセスも「自分が勝者」と誤認し、追跡していないサーバープロセスが孤児として
  生存し続ける事象を観測した（`test-result.md`「観測されたレア事象」）。単体実行6/6・
  全体実行での再実行でも大半は正しく収束し、10回以上の意図的な再現の試みでは
  直接再現できなかった。
- **決定**: 原因の完全な特定・恒久的な修正（例: advisory file lock等による真の相互排他への
  置き換え）は今回のworkでは行わない。`.aidev/backlog/session-lifecycle.md`へ記録し、
  次のworkへ送る。
- **理由・代替案**:
  - 検討した代替案1: この場で`ServiceManager.acquire()`の調停ロジックを真の排他ロックへ
    作り直す。却下理由——**1回しか観測できておらず、機序を実プロセスで確定できていない**
    （AGENTS.md「判断の原則」2「実機で確定できることは必ず実機で確定する」「1回の観測で
    決めない」に照らすと、確認できていない機序に対して設計変更を行うのは推測による判断に
    あたる）。加えて、ロックファイル調停プロトコルそのものは`02-extension-core`の設計・
    実装範囲であり、`04-packaging`（このworkが今いる統合testの文脈）の範囲を超える。
  - 検討した代替案2: このまま握りつぶして記録もしない。却下理由——単一利用者の
    ローカルツールとして実害は限定的（既存の`killByPid`のpid再利用リスクと同じ「許容する」
    設計方針の範囲内）だが、記録せずに進むと`AGENTS.md`「確かめられなかったことは
    未確認と明記して残す。埋めない」に反する。
  - 採用: 実プロセス統合テスト自体は残す（レアな競合を検知できる回帰資産として価値がある。
    実際に1回だけだが検知に成功している）。機序と恒久対応はbacklogへ送り、次にこの領域へ
    着手する人が実機で確定できることを最初から実機で確定できるよう、観測事実・試した
    再現条件・却下した代替案を記録として残す。
- **影響**: `test-result.md`に観測事実を記録。`.aidev/backlog/session-lifecycle.md`に
  follow-up項目を追加（`aidev backlog add`）。deliverのPR本文「既知の制約」にも引き継ぐ。

## D3: deliver後、利用者の実機（Windows）検証で見つかった診断出力の欠陥を同じPRで直す

- **背景**: PR #414 作成後、利用者が実際に`.vsix`をWindows環境へインストールして動作確認したところ、
  「サーバーが起動しませんでした（port 34000）」というエラーが出た一方、「ts5250」出力パネルには
  **何も出力されていなかった**。
- **原因**: `vscode-extension/src/extension.ts`の`acquireService`は、`serviceManager.acquire()`が
  **成功して初めて**返ってきた`child`のstdout/stderrへ`on("data", ...)`を配線していた。
  つまり`acquire()`が失敗（`SPAWN_TIMEOUT_MS`＝20秒でhealthzに届かない等）した経路では、
  子プロセスが起動中に出していたはずの診断出力（エラーメッセージ含む）を**誰も読んでおらず**、
  OSのパイプバッファの中で失われたまま`acquire()`が例外を投げていた——「なぜ失敗したか」が
  一番知りたい場面で診断できない状態になっていた。加えて、失敗時に`child`をkillしておらず、
  healthzに応答しないままどのロックにも載らない孤児プロセスが残るリスクもあった。
- **決定**: `ServiceManager`に`onChildOutput`（成否が確定する前から呼ばれるコールバック）を
  追加し、`spawn`直後（healthz待ちの前）にstdout/stderrを配線するよう`acquire()`自身へ移した。
  失敗（タイムアウト／spawn自体のerrorイベント）した経路では、投げる前に`killByPid`で
  自分の子を畳むようにした。`extension.ts`側は`ServiceManager`のコンストラクタへ
  `onChildOutput: (chunk) => output.append(chunk)`を渡すだけになり、成功後にしか配線しない
  旧経路は削除した。
- **理由・代替案**:
  - 検討した代替案: `SPAWN_TIMEOUT_MS`（20秒）を単純に延ばす。却下理由——原因不明のまま
    数値をいじるのは推測による判断（AGENTS.md「判断の原則」2）。まず診断出力を復元し、
    実際に何が起きているか（遅いだけか、本当に起動できないか）を利用者の実機で確認する方が先。
  - 採用理由: 診断出力の欠落は、成否に関わらず起きる構造的な欠陥（配線のタイミングの問題）
    であり、根本を直すのが筋。孤児プロセス化の防止も同じ`acquire()`の失敗経路に付随する
    別の欠陥として合わせて直した（別PRに分けるほどの独立性は無い）。
  - **副次的に見つかった安全上の問題**: `vscode-extension/test/serviceManager.test.ts`の
    「healthzがタイムアウトし続けたら...」テストが`fakeChild(1)`（pid=1）を使っており、
    `process.kill`をモックしていなかった。この工程の変更で`acquire()`の失敗経路が
    新たに`killByPid`を呼ぶようになったため、**このコンテナのPID 1（`/sbin/init`）へ
    実際にSIGTERMを送りかねない状態**だった。同じ問題は「heartbeatはacquireしていない
    windowIdでは何もしない」テスト（`release()`経由。こちらは元から`killByPid`を呼ぶ
    既存コードで、今回の変更とは無関係に以前から存在していた）にもあった。両方とも
    `process.kill`をモックして直した（実行前に気づき、実際の signal は送っていない）。
- **影響**: `vscode-extension/src/serviceManager.ts`・`src/extension.ts`・
  `test/serviceManager.test.ts`・`test/extension.test.ts`を変更。`test-result.md`に
  再テスト結果を追記。同じPR #414（未マージ）へ追加コミットする。

## D4: `context.globalStorageUri`のディレクトリを`activate()`の冒頭で作る

- **背景**: D3の修正で出力パネルに診断出力が届くようになった結果、利用者（Windows）の実機から
  実際のエラーが取れた: `ENOENT: no such file or directory, open '...\globalStorage\
  asaomaro.ts5250-vscode\.env'`（`packages/server/src/secret-crypto.ts`の`persistKey`が
  `writeFileSync`する際、親ディレクトリが存在しなかった）。
- **原因**: VSCodeの`context.globalStorageUri`は**物理的に存在する保証が無い**（初回
  インストール直後、拡張機能自身がまだ何も書き込んでいない状態ではディレクトリごと
  存在しない）。`ServiceManager.writeLock()`は自分のロックファイル書き込み前に
  `mkdirSync(dirname(...), {recursive:true})`していたので無事だったが、**別プロセス**
  として`spawn`する`packages/server`側（`--secret-key-file`/`--connections`）は
  親ディレクトリを作らずに書き込もうとしており、`extension.ts`側も`spawn`する前に
  ディレクトリの存在を保証していなかった。
- **決定**: `extension.ts`の`activate()`冒頭（`ServiceManager`を構築する前）で
  `mkdirSync(globalStorageDir, { recursive: true })`を呼び、以降のあらゆる書き込み
  （ロックファイル・`.env`・`connections.json`・`systemRefs.json`）の前提を一括して
  満たす。
- **理由・代替案**:
  - 検討した代替案: `packages/server`側（`secret-crypto.ts`の`persistKey`・
    `config-store.ts`の保存経路）を個別に`mkdirSync`対応させる。却下理由——
    `packages/server`はVSCode拡張だけでなくElectron版・CLI起動でも共有されるコードで、
    **他の起動経路では既にディレクトリが存在する前提が成立している**
    （Electronの`userData`パスはOSが用意する）。共有コード側を直すより、
    「ディレクトリが存在しない」という前提を初めて破っている呼び出し元
    （VSCode拡張）側で保証する方が影響範囲が小さく、正しい層に置ける。
  - 採用理由: 実機（Windows）で実際に再現・修正確認した
    （`node packages/server/dist/main.js`を、親ディレクトリの無いパスへ
    `--secret-key-file`指定して直接起動し、同じENOENTを再現。ディレクトリを
    事前に作ってから同じコマンドを起動すると解消することを確認済み）。
- **影響**: `vscode-extension/src/extension.ts`・`test/extension.test.ts`を変更。
  同じPR #414（未マージ）へ追加コミットする。

## D5: I902（起動成功）の直後に切れたセッションの理由をログへ残す（`packages/tn5250`）

- **背景**: D4の修正後、利用者（Windows・実機ホストS7857290）の検証で
  `startup response I902`（起動成功）に続けて`ws_open`が`SESSION_CLOSED`で失敗する事象を確認した。
  出力パネルにI902は出ていたが、`SESSION_CLOSED`の**具体的な理由**（`closed during negotiation:
  <reason>`）はどこにも出ていなかった——`packages/server/src/audit.ts`の`withAudit`は
  コードだけを監査ログへ残しmessageは残さない。`packages/web-ui/src/composables/
  opMessages.ts`の`wsErrorNotice`は`SESSION_CLOSED`を`CODES_WITH_FIELD_DETAIL`に含めておらず、
  画面には汎用文言（「セッションは閉じています」）しか出さない。**理由を見る手段が
  サーバー側のログしか残っておらず、そのログにも出ていなかった**。
- **原因**: `packages/tn5250/src/session/session.ts`の`establish()`内、`telnet.onClose`ハンドラは
  `SESSION_CLOSED`のAs400Errorを`reject`するだけで、`this.warn(...)`を呼んでいなかった
  （同じ関数内の他の分岐——8902の聞き直し・起動応答の失敗コード・成功コードのログ——は
  いずれも`this.warn`を呼んでいるのに、この分岐だけ抜けていた）。
- **決定**: `reject`の直前に`this.warn(\`closed during negotiation: ${reason}${hint}\`)`を追加した。
  `warn`は`session-manager.ts`で`sessionLog.warn({sessionId}, m)`へ配線されており、
  VSCode拡張の出力パネル（D3の修正で成否確定前から配線済み）にもそのまま届く。
- **理由・代替案**:
  - 検討した代替案: `audit.ts`の`withAudit`にエラーmessageも記録する／`wsErrorNotice`で
    `SESSION_CLOSED`もmessageを出すようにする。却下理由——前者は監査ログの設計方針
    （個人情報・接続先の詳細を監査ログに積み上げない）に踏み込む判断で、このPRの
    スコープを超える。後者はweb-ui全体（VSCode拡張専用ではない）のUI文言方針に関わり、
    同じく単独の判断では踏み込めない。どちらも**別work**の対象として残す。
  - 採用理由: `this.warn`を配線し忘れていた箇所への1行追加であり、既存の分岐と対称に
    揃えるだけ。挙動は変えず、ログにだけ情報を足す最小の変更。
  - **点検の扱い**: `cross`のtaskcheckラウンド上限（2/2）に達したため、この工程での
    独立点検は行わず、次のreview工程での点検に委ねる（`aidev-40-coding`手順5の指示どおり）。
- **影響**: `packages/tn5250/src/session/session.ts`（1箇所）・
  `packages/tn5250/test/startup-reject.test.ts`（`fakeTransport`に`closeWith`を追加・
  テスト1件追加）を変更。tn5250パッケージ全体のテスト（894件）を実行し green を確認。
  同じPR #414（未マージ）へ追加コミットする。**利用者の実機ホストへの実接続そのものは
  未解決**——このログ追加は次回の再現時に理由を見えるようにするための対応で、
  「なぜ切れるか」自体の根本原因は利用者の再検証結果を待つ。

### D5の追記: D5適用後の再検証で分かったこと、および見送った追加診断ログ

D5適用後、利用者が再検証したところ、実際のログは
`closed during negotiation: closed by client`（監査コードは`NEGOTIATION_TIMEOUT`、
durationMs=15023）だった。**`"closed by client"`は`packages/tn5250/src/transport/tcp.ts`の
`close()`メソッド自身が付ける文言**——つまりホストが切ったのではなく、
**`establish()`の15秒タイマー（`negotiationTimeoutMs`の既定値）が先に`reject`し、
その直後に`this.telnet.close()`を呼んだことで`onClose`ハンドラが動き、D5で追加した
`this.warn`がその中で（既に確定した`ready`の再rejectは無視されつつ）ログだけ出した**、
という経緯だと判明した。つまり**ホスト側が拒否・切断したのではなく、起動応答I902の後、
15秒間「Readを伴うレコード」が一度も届かず、こちら側のタイムアウトが自発的に
接続を畳んだ**、というのが正しい理解。

- **試して却下した追加診断**: `handleRecord`内、`this.state === "negotiating"`の間に
  受信した全レコードを`this.warn`で無条件にログする案を試したが、
  `packages/tn5250/test/save-screen-session.test.ts`の「1レコードにSAVEが2回...
  どちらの段を復元しても警告が出ない」テストが実際に落ちた——**通常の正常系でも
  複数レコードに分かれた交渉が普通に起きる**ため、無条件ログは毎回の接続でログを
  埋め尽くすノイズになる（`warn`は異常時専用という既存の作法に反する）。
  コードは追加せず元に戻した（実測でノイズと判明したため。コミットには含まれない）。
- **残る手段**: 本当にワイヤレベルで何が届いているか（あるいは本当に何も届いていないか）を
  見るには、既存の`AS400_TRACE_RECORDS=1`（`packages/server/src/session-manager.ts`の
  `traceRecordsEnabled()`）で全レコードのhexダンプを取る必要がある。ただしVSCode拡張は
  VSCode自体のプロセス環境を継承するため、利用者にVSCode起動前にこの環境変数を
  設定してもらう必要があり、UXとしては重い——**次に着手する人は、まずこの環境変数を
  使わずに済む代替（例: ホスト側の設定・実機での別デバイス名での再現有無）を先に
  利用者へ尋ねるところから始めるとよい**。

### D5の解決（利用者確認済み）

`.ts5250`の`deviceName`を明示指定したところ、正常に接続できることを利用者が確認した
（`sample.ts5250`は自動割り当て——`deviceName`省略——のままだった）。

- **確定した理解**: このホスト（S7857290）は、装置名を自動割り当て（`QPADEV*`系）で
  接続すると、最初の「Readを伴う画面」が`negotiationTimeoutMs`の既定値（15秒）以内に
  届かない。装置名を明示すると即座に届く。ホスト側の装置クラス設定・初回の装置記述
  作成コスト等、こちら側のコードの外側にある挙動と判断する（同じ`session.ts`のコードは
  このwork中に他の実機（SR-OSAKA・PUB400）へ自動割り当てで繋いだ実績があり、
  自動割り当てそのものが常に遅いわけではない）。
- **このworkでは対応しない**: `negotiationTimeoutMs`の既定値を一律に延ばす・`.ts5250`
  スキーマで`deviceName`を必須にする、はいずれも1件の実機報告だけを根拠にした
  仕様変更になり、AGENTS.md「判断の原則」2（推測による判断を行わない・1回の観測で
  決めない）に照らして見送る。利用者は装置名の明示で解決済み。将来、同じ症状の報告が
  複数集まった場合の参考として、この経緯をここに残す。
- **PR #414への影響**: 追加のコード変更は無し（D3〜D5のログ改善が、この切り分けを
  可能にした）。
