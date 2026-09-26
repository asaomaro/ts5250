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

## D6: `EmbedApp.vue`に「⚙ 表示」（画面の見え方の設定）ボタンを追加する

- **背景**: 利用者から「表示関連の設定ボタンを上部に配置してください」という要望があった。
  調べたところ、`App.vue`（通常のワークスペースUI）には`ViewSettingsMenu`
  （ボタン表記「⚙ 表示」。title「表示（このペインの見え方）」——SO/SI表示・カナ/表示コード・
  リンク化・フォント等）が既にあるが、`EmbedApp.vue`（VSCode拡張のWebView）は
  design.md「設計方針4」の「タブ帯・システム切替・ランチャーは一切持たない」という
  意図的な最小化のもと、この機能ごと実装されていなかった。利用者が指す「表示関連の
  設定ボタン」はこの`ViewSettingsMenu`であると判断した。
- **決定**: `EmbedApp.vue`のヘッダーへ`ViewSettingsMenu`を追加し、既存の接続設定ボタン（⚙）と
  並べて画面上部に配置した。対象は`App.vue`の`viewMenuTarget`と同じ判断——
  emulatorは全項目、printer(スプール表示)は帳票向けに絞った`REPORT_VIEW_KEYS`のみ、
  sql/ifsは対象外（5250画面でも帳票でもないため）。
- **理由・代替案**:
  - **`REPORT_VIEW_KEYS`の重複を避けた**: 元は`App.vue`内のローカル定数だったが、
    `EmbedApp.vue`も同じ値を必要としたため、`stores/viewSettings.ts`（`ViewKey`の定義元）
    へ`export const REPORT_VIEW_KEYS`として切り出し、両方から共有させた
    （AGENTS.md「同じ判断を2か所に持つと片方だけ直る事故が起きる」の教訓・
    `.aidev/conventions/paired-artifact-sync.md`と同じ考え方）。
  - **sql/ifsには付けない**: `App.vue`の`viewMenuTarget`が元々sql/ifsタブを対象外にしている
    （5250画面表示・帳票表示のどちらでもないため、SO/SI表示等の項目が意味を持たない）ことと
    一貫させた。個別の要望が出れば別途検討する。
- **検証**: 型検査（`vue-tsc`）・`packages/web-ui`全体のテスト（2669件）green を確認。
  加えて、実際に`packages/server`を起動し`packages/web-ui/dist`（再ビルド済み）を配信して
  実ブラウザ（Playwright）で`embed.html?app=printer`を開き、
  (1) 接続前はボタンが出ない、(2) `systemRef`が入ると「⚙ 表示」ボタンが接続設定ボタンの
  左に並んで表示される、(3) クリックすると`REPORT_VIEW_KEYS`に絞ったポップオーバー
  （SO/SI表示・表示コード・リンク化・フォント（画面）のみ、5250画面専用項目は出ない）が
  正しく開く、をスクリーンショットで確認した。emulator側は実機ネットワーク到達性の
  制約（このセッションの環境からは実機ホストへ接続できなかった）で画面までは確認できな
  かったが、`viewMenuTarget`の分岐はprinter側と対称な実装であり、型検査・既存テストで
  裏付けている。
- **影響**: `packages/web-ui/src/EmbedApp.vue`・`packages/web-ui/src/App.vue`・
  `packages/web-ui/src/stores/viewSettings.ts`を変更。同じPR #414（未マージ）へ追加コミットする。

## D7: `EmbedApp.vue`に「外観」（テーマ・スキン選択）ボタンを追加する

- **背景**: D6の直後、利用者から「テーマ選択ボタンも表示させて」との追加要望があった。
  `App.vue`のコメント（`viewMenuTarget`の直前）に「**テーマ（通常/ダーク）はここに出さない。
  アプリ全体の『外観』が持っている**」とあり、テーマ切替は`ViewSettingsMenu`（表示。D6で
  追加済み）ではなく`DesignMenu`（外観。ボタン表記「外観」・title「外観（アプリ全体の
  見た目）」）が担う、別の既存コンポーネントだと判明した。
- **決定**: `EmbedApp.vue`のヘッダーへ`DesignMenu`を追加した（`<ViewSettingsMenu>`と
  `<button class="settings-btn">`の間）。`DesignMenu`は`App.vue`でも`<DesignMenu />`と
  無props・無条件で呼ばれており（`useSkin`/`useTheme`/`appearance`ストアを内部で直接参照）、
  `EmbedApp.vue`側にも計算対象を用意する必要が無い——単純な追加。`embed.ts`は既に
  `initTheme()`/`initSkin()`/`initAppearance()`を呼んでおり（`main.ts`と同じ順序）、
  `DesignMenu`が要る状態は全て初期化済みだった。
- **理由・代替案**: 検討の余地なし——`App.vue`に既にある確立済みのコンポーネントを
  そのまま流用するのが唯一の妥当な選択（独自実装を作らない）。
- **検証**: 型検査（`vue-tsc`）・`packages/web-ui`全体のテスト（2669件）green。加えて
  実際にサーバーを起動し実ブラウザ（Playwright）で確認: 「⚙ 表示」「外観」「⚙」の3つが
  ヘッダーに並んで表示され、「外観」をクリックするとスキン一覧（5250端末/WEBアプリの
  各スキン）・表示モード（通常/ダーク/システム）を含むポップオーバーが正しく開くことを
  スクリーンショットで確認した。コンソールエラー0件。
- **影響**: `packages/web-ui/src/EmbedApp.vue`のみ変更。同じPR #414（未マージ）へ
  追加コミットする。

## D8: WebViewの`<iframe>`に`allow="local-fonts"`を足す（画面フォント選択が「標準（自動）」しか出ない）

- **背景**: D6/D7の直後、利用者から「フォントが標準（自動）しか選択できません」との
  報告があった。`ViewSettingsMenu`の画面フォント選択（`screenFonts.ts`の
  `listInstalledFonts()`）は`queryLocalFonts()`（Local Font Access API）でインストール済み
  フォントを列挙するが、失敗時は`null`を返し黙って「フォント名を直接入力」欄へ倒す
  設計になっている（コメント: 「判定は...Local Font Accessの許可に左右され...外しても
  桁は崩れない」）。
- **原因（実測で特定）**: `vscode-extension/src/webviewHtml.ts`の`buildShellHtml`が
  組み立てる`<iframe>`（`embed.html`を読み込む、`design.md`「設計方針5」）に
  `allow="local-fonts"`が無かった。Local Font Accessは強力な機能としてPermissions
  Policyでゲートされており、クロスオリジンiframeへは`allow`属性で明示しないと
  既定で継承されない。**実際に確かめた**（`test/webviewHtml.test.ts`と同じ構造を
  再現したshell HTMLをPlaywrightで用意し、`allow`の有無を切り替えて`queryLocalFonts()`を
  呼んだ）——`allow`無しでは`SecurityError: Access to the feature "local-fonts" is
  disallowed by Permissions Policy`が実際に発生し、`allow="local-fonts"`を付けると
  発生しなくなることを確認した。`listInstalledFonts()`はこの`SecurityError`を
  「非対応」の一種として`catch`し`null`へ倒すため、利用者からは「一覧が一切出ない」
  としか見えていなかった。
- **決定**: `<iframe id="embed">`へ`allow="local-fonts"`を追加した。
- **理由・代替案**:
  - 検討した代替案: `screenFonts.ts`側でフォント一覧を諦め、常に「直接入力」だけの
    UIにする。却下理由——原因が明確に`allow`属性の欠落だと実測で特定できており、
    1行の追加で直る可能性が高いのに、機能そのものを引っ込めるのは筋が違う。
  - **この修正だけで十分とは断定していない**: VSCode拡張の`Webview`自体
    （`buildShellHtml`が返すHTMLを表示する、より外側のコンテキスト）が、
    そもそもこの種の強力な機能を拡張のWebviewへ許可しているかどうかは、
    **実際のVSCode拡張ホストが無いこの開発環境では確認できない**
    （`02-extension-core`以来一貫している制約）。AGENTS.md「判断の原則」2に
    従い、確認できていないことは「未確認」と明記する——直った/直っていないは
    利用者の実機での再検証を待つ。
  - **どちらにせよフォールバックは健全**: 許可されなければ従来どおり
    「フォント名を直接入力」欄で任意のフォント名を指定できる（`onFontNameApply`は
    `queryLocalFonts`に依存しない別経路）。
- **検証**: `vscode-extension`のテスト（74件。新規1件を含む）green。
  新規テストは実際にmutationで検証済み（`allow`属性を外すと失敗することを確認してから戻した）。
- **影響**: `vscode-extension/src/webviewHtml.ts`・`vscode-extension/test/webviewHtml.test.ts`
  を変更。同じPR #414（未マージ）へ追加コミットする。

### D8の結論（利用者確認済み。未確認だった点が確定した）

利用者が`allow="local-fonts"`適用後の`.vsix`で再検証したところ、**フォント一覧は
依然として出ない**（「フォント名を直接入力」は正しく反映される）ことを確認した。
ブラウザ単体（通常のワークスペースUI）ではフォント一覧を選べるとの補足も得た。

- **確定した理解**: `webviewHtml.ts`の`<iframe>`側のPermissions Policyの障壁は
  実測で取り除けている（D8本文の検証）が、**VSCode拡張のWebview自体（`buildShellHtml`が
  返すHTMLを表示する、より外側のコンテキスト）がLocal Font Access自体をそもそも
  許可していない**、というのが残る唯一の説明と判断する——`<iframe>`側の許可は
  必要条件ではあったが十分条件ではなかった。VSCode拡張のWebview APIには、
  この種の強力なPermissions Policy機能を拡張側から許可へ格上げする手段が無い
  （`vscode.WebviewOptions`は`enableScripts`/`localResourceRoots`等に限られ、
  Feature/Permissions Policyの制御は含まない）。
- **このworkでは対応しない**: VSCode本体側の制約であり、拡張のコードからは
  解決できない。`document.fonts`（CSS Font Loading API）等の代替手段も、
  「既に使われているフォント」しか見えず「インストール済みフォントの一覧」の
  代替にはならないため採用しない。
- **利用者への案内**: VSCode拡張では「フォント名を直接入力」欄を使うのが
  正しい使い方——`screenFonts.ts`の設計（一覧を出せないブラウザでも名前で
  指定できるフォールバック）が、VSCode拡張という新しい利用環境でもそのまま
  機能しており、機能そのものは失われていない。
- **`allow="local-fonts"`は残す**: 単体では効果が無かったが、誤った変更ではない
  （必要条件は満たしている。VSCode側が将来この機能を許可するようになった場合や、
  他の埋め込み文脈で効く可能性があるため、削除する理由が無い）。

## D9: `ViewSettingsMenu`（表示）のポップオーバーにも内部スクロールの上限を付ける

- **背景**: 利用者から「外観ボタンから展開する設定ウィンドウは、高さが一定以上の場合に
  内部に縦スクロールバーを表示しているので、表示ボタンから展開する設定ウィンドウも
  同様に縦スクロールバーを表示させてください。設定ウィンドウの高さは画面全体の高さを
  超えて画面全体の縦スクロールバーが表示されない範囲に制御してください」との指摘があった。
- **原因**: `DesignMenu.vue`（外観）の`.dz-menu`は`max-height: 74vh; overflow-y: auto;`を
  持つが、`ViewSettingsMenu.vue`（表示）の`.vsm-menu`にはどちらも無かった——
  項目数が多い（emulator向けはフォント欄を含め項目数が最大）状態で、画面の高さが
  低い（VSCode拡張のWebViewパネル等）と、ポップオーバーが画面からはみ出し、
  **ページ全体が縦スクロールしてしまう**状態になっていた。
- **決定**: `.vsm-menu`へ`.dz-menu`と同じ`max-height: 74vh; overflow-y: auto;`を追加した。
- **理由・代替案**: 検討の余地なし——同じヘッダーに並ぶ2つのポップオーバーで
  片方だけ挙動が違うのは単純な実装漏れであり、既にある`.dz-menu`の値をそのまま
  揃えるのが唯一の妥当な選択。
- **共通部品であることの確認**（利用者からの追加の確認要望）: `ViewSettingsMenu.vue`は
  `App.vue`（通常のワークスペースUI）と`EmbedApp.vue`（VSCode拡張のWebView）の
  **両方が同じファイルをそのまま使っている**共有コンポーネントであり、この1箇所の
  修正で両方に自動的に反映される。個別の対応は不要。
- **検証**: `packages/web-ui`全体のテスト（2669件）green。加えて実際にサーバーを
  起動しブラウザ（Playwright）で、**意図的に低いビューポート**（700×260px。狭い
  VSCodeパネルを模した）で「表示」ポップオーバーを開き、`getComputedStyle`で
  実測した: メニューの`max-height`が`192.4px`（＝260pxの74%）に制限され、
  内容の高さ（`scrollHeight`）は268pxと上限を超えているにもかかわらず、
  **`document.documentElement`（ページ全体）はスクロール不要**（`pageScrollable: false`）
  であることを確認した。スクリーンショットでもポップオーバー自身の枠内で
  切れていることを確認した。
- **影響**: `packages/web-ui/src/components/ViewSettingsMenu.vue`のみ変更
  （`App.vue`・`EmbedApp.vue`双方に自動反映）。同じPR #414（未マージ）へ
  追加コミットする。

## D10: VSCode拡張機能のアイコンをfavicon/electronアイコンと同じ絵にする

- **背景**: 利用者から「VSCode拡張機能のアイコンにもfaviconやelectronアイコンと
  同じアイコンを設定してください」との要望があった。
- **調査**: アイコンの絵は`packages/web-ui/scripts/gen-icons.mjs`が**唯一の定義元**
  （`ts`のモノグラム＋カーソル下線を図形定義から自前でラスタライズする）で、
  そこから`favicon.svg`/`favicon.ico`/`apple-touch-icon.png`（`packages/web-ui/public/`）と
  `electron/build/icon.png`（1024×1024。electron-builderがexe/dmg/AppImage全部に使う）を
  生成している。スクリプル冒頭のコメントに明記された設計思想:
  「ブラウザのファビコンとElectronのアプリアイコンは同じ絵なので、出力先が2つでも
  定義は1つに保つ——バイナリを手で置くと、色を直したときに片方だけ古いまま残り、
  しかも見比べるまで気づかない」。
- **決定**: この設計に**素直に第3の出力先として乗る**（新規に絵を作らない・
  手でコピーしない）。`gen-icons.mjs`へ`VSCODE_OUT`（`vscode-extension/`）を追加し、
  `emit(VSCODE_OUT, "icon.png", png(render(128, 4), 128))`で128×128のPNGを生成した
  （VS Code Marketplaceの推奨サイズ「128×128以上」に合わせた——electron-builderの
  icns生成のような下限制約が無いぶん、電子版の1024より小さくてよい）。
  `vscode-extension/package.json`へ`"icon": "icon.png"`を追加した。
- **理由・代替案**: 検討の余地なし——単一の定義元から出す既存の設計に従うのが
  唯一の妥当な選択。手でPNGを1つ作って置く方法は、この設計思想（「片方だけ古いまま
  残る」問題を避けるため2出力先を1定義に保った）にそのまま反する。
- **検証**: `npm run gen:icons`を実際に実行し、新規`vscode-extension/icon.png`
  （128×128 PNG）が生成されることを確認。**既存の3出力（favicon.svg/ico・
  apple-touch-icon.png・electron/build/icon.png）はバイト単位で無変更**
  （`git status`に現れず——生成が決定的であることの裏付け）。`npx @vscode/vsce package`を
  実際に実行し、`.vsix`内に`icon.png`が含まれること・`extension.vsixmanifest`に
  `<Icon>`要素として登録されることを確認した。`vscode-extension`のテストは
  74件中73〜74件green（実プロセスを使う統合テストが全ファイル並行実行下で
  時折flakeするのは`decisions.md` D2と同種の既知の特性——単体実行では常にgreen。
  今回の変更（アイコンファイル・`package.json`の`icon`欄）とは無関係）。
- **影響**: `packages/web-ui/scripts/gen-icons.mjs`・`vscode-extension/package.json`を変更。
  `vscode-extension/icon.png`を新規追加（他の生成済みアイコンと同じくgit管理下に置く）。
  同じPR #414（未マージ）へ追加コミットする。

## D11: VSCodeのファイル一覧（Explorer）でも`.ts5250`にts5250アイコンを出す

- **背景**: 利用者から「VSCode拡張機能をインストールすると、VSCodeのファイル一覧に、
  .ts5250ファイルのアイコンをts5250アイコンにすることはできますか？」との追加要望が
  あった。D10で対応した拡張機能自体のマーケットプレイス上のアイコン（`package.json`の
  `icon`欄）とは別物——**Explorer（ファイル一覧）での個別ファイルアイコン**は
  別のVSCode拡張APIが要る。
- **調査（WebSearchで確認。推測で実装しない）**: VSCodeには`contributes.languages[].icon`
  （`light`/`dark`のペア）という、この用途にちょうど合う安定版APIがある——
  「利用者が選んでいるファイルアイコンテーマがその言語専用のアイコンを持っていない
  場合のフォールバックとして使われる」ため、**利用者にアイコンテーマの切り替えを
  要求しない**（Microsoft公式ドキュメント・GitHub issue #140047で確認）。
  API finalization（proposed API解除）は2022年1月のマイルストーン向けで、この拡張の
  `engines.vscode`（`^1.90.0`。2024年5月リリース）より十分前——互換性の懸念は無い。
  検討した代替案（`contributes.iconThemes`でアイコンテーマそのものを作る）は、
  利用者に明示的なテーマ切り替えを要求する重い手段のため却下した——今回の要望
  （「一覧のアイコンをts5250にしてほしい」）に対して過剰。
- **決定**: `vscode-extension/package.json`へ`contributes.languages`を新規追加した:
  ```json
  { "id": "ts5250", "extensions": [".ts5250"], "icon": { "light": "./icon.png", "dark": "./icon.png" } }
  ```
  アイコンはD10で作った`icon.png`（favicon/electronと同じ絵）を**そのまま再利用**した
  ——新規の絵を作らない・新規ファイルを増やさない。既存の`customEditors`契約
  （`.ts5250`をカスタムエディタで開く）とは独立した別のVSCode機構なので、
  どのエディタで開くかには影響しない（`languages`はファイルの「言語」認識と
  アイコン表示だけを担う）。文法定義（`grammars`）は追加していない——
  シンタックスハイライトは要望の対象外で、スコープを広げない。
  `light`/`dark`を同じファイルにしているのは、このアイコンの絵自体が
  固定の濃い背景を持つデザイン（`gen-icons.mjs`の`BG`定数で塗った角丸矩形）で、
  テーマに関わらず同じ見た目でよいため（透明背景ではなく、favicon/apple-touch-icon
  等と同じ「アプリアイコン」然としたデザイン）。
- **検証**: `package.json`が有効なJSONであること・`npx @vscode/vsce package`が
  新規の警告なく成功すること・生成された`.vsix`内の`package.json`に
  `contributes.languages`が意図どおり埋め込まれていること（`unzip`で取り出して
  確認）を確かめた。**実際のVSCode拡張ホストでExplorer上の表示を目視確認することは
  できていない**——このコンテナには実行可能なVSCode拡張ホストが無い制約
  （`02-extension-core`以来一貫）。利用者の実機での確認を待つ。
  `vscode-extension`のテスト（74件）はmanifestのみの変更のため無関係でgreen。
- **影響**: `vscode-extension/package.json`のみ変更。同じPR #414（未マージ）へ
  追加コミットする。

## D12: ステータスバーの「✉ メッセージあり」をクリックしてメッセージを読めるようにする

- **背景**: 利用者から「✉ メッセージあり」表示の仕組みを聞かれ（`packages/web-ui/src/
  components/StatusBar.vue`の`.msgwait`。5250のMessage Waiting light）、続けて
  「クリックするとウィンドウでメッセージを表示するようにできますか？」と要望があった。
- **設計上の分岐点（利用者に確認）**: メッセージの本文は5250プロトコルには乗らず、
  SQL経由（`QSYS2.MESSAGE_QUEUE_INFO`。`/api/host/messages`）で読む必要があると判明。
  このAPIは登録済みのsystem参照を要求するが、**エミュレータは直接接続**（design.md
  「設計方針3」。system登録不要）で開けるため、参照が無い場合がある。利用者に
  「システム登録を自動で行う（printer/sql/ifsと同じsyncSystemをemulatorにも拡張）」か
  「直接接続では機能を出さない」かを確認し、**前者**を選んだ
  （接続に張りっぱなしの負荷が増えないことも確認済み——`syncSystem`はローカル設定
  ファイルへの登録だけでAS/400への接続を伴わず、メッセージ取得自体も`/api/host/
  messages`が毎回開いて閉じる短命の接続で、セッション数に比例して常駐接続が
  増えるわけではない）。
- **決定**:
  1. **`vscode-extension/src/ts5250EditorProvider.ts`の`resolvePayload`を拡張**——
     `emulator`でも`syncSystem`を呼び`systemRef`を付加する。ただし`user`/`password`は
     **削除しない**（`WsOpen`直接指定はそのまま使う。`systemRef`は付加的な用途
     ——メッセージ表示等system参照を要求するREST機能のためだけ）。
  2. **`EmbedApp.vue`**: `openSession()`の第4引数へ`payload.systemRef`をそのまま渡す
     （`SessionState.systemRef`へ乗る既存の仕組みをそのまま使う。サーバー側の変更は
     不要）。`meta.signonUser`も新たに乗せる（メッセージ待ち行列の既定値に使う——
     IBM iの慣習で各ユーザーprofileには同名の待ち行列が既定で紐づく）。
  3. **`StatusBar.vue`**: `.msgwait`を`<span>`から`<button>`へ変更しクリック可能に
     した。`state.systemRef`が無いときは`disabled`のまま（隠さない——「届いている」
     こと自体は有用な情報のため。直接接続で開いた本来のWebアプリのセッション等、
     参照を持たない場面は今も残る）。
  4. **新設`MessageQuickView.vue`**: `MessagePane.vue`（ランチャーから開くフル機能。
     読む・応答する・消す・送る）の縮小版——**読む・照会に応答するだけ**に絞った
     ポップオーバー（消す・送るは持たない。誤操作の芽を増やさない）。
     `docs/UI-DESIGN.md`「情報ポップオーバー」の構造規約（バックドロップ＋
     `position:absolute`＋`@click.stop`）と、D9で足した`max-height:74vh;
     overflow-y:auto`をそのまま踏襲した。ステータスバー（画面下部）が起点なので
     `bottom: calc(100% + 6px)`で上向きに開く（ヘッダーのポップオーバーとは逆）。
  5. **`stores/sessions.ts`は変更不要**——`SessionState.systemRef`/`SessionMeta.
     signonUser`は既存のフィールドで、`openSession()`の引数として既に対応していた
     （呼び出し側が渡していなかっただけ）。
  6. **共有コンポーネントなので通常のWebアプリにも自動的に反映される**（利用者からの
     確認要望への回答どおり。`App.vue`/`EmbedApp.vue`どちらも`StatusBar.vue`を
     そのまま使う）。
- **見つけて直した副次的なバグ**: `MessageQuickView.vue`のテストを書く過程で、
  「応答すると一覧が読み直されない」という不具合を実際に踏んだ——`reply()`が
  自分の`withBusy`の中から`refresh()`を呼んでおり、`refresh()`自身の
  `busy.value`ガードが（外側の`withBusy`がまだ立てている）常にtrueを見て
  短絡し、読み直しが起きなかった。**同じ組み合わせ方を`MessagePane.vue`
  （`reply`/`remove`/`doSend`の3箇所）も持っており、同じ穴があった**——
  こちらは既存テストが無く素通りしていた。両方とも「`busy`ガード無しの
  `fetchMessages()`を切り出し、`refresh()`はガード付きでそれを呼ぶ／
  `reply`等は自分の`withBusy`の中では素の`fetchMessages()`を直接呼ぶ」形へ
  直した。**mutationで検証済み**（`fetchMessages()`を`refresh()`へ戻すとテストが
  実際に落ちることを確認してから戻した）。`MessagePane.vue`には回帰テストが
  1件も無かったため、この修正を固定する最小のテストを新規に追加した。
- **検証**:
  - 型検査（`vue-tsc`）・`packages/web-ui`全体のテスト（2683件）・
    `vscode-extension`全体のテスト（75件）green。
  - **実機での実プロセス確認**: `.env`/`.env.verify`（SR-OSAKA）を使い、
    (1) `POST /api/systems`での実際の登録、(2) `POST /api/host/messages/send`で
    自分の待ち行列へ実際にメッセージを送信、(3) `POST /api/host/messages`で
    実際に読み出せること、を実プロセス・実ホストで確認した。
  - **実ブラウザでのUI一気通貫（クリック→ポップオーバー→実メッセージ表示）は
    未達**——実機のエミュレータ接続（TN5250）を試みたが、既定の装置名
    （`AS01`。`profiles.local.json`の確立済み設定）が利用者自身の別セッションで
    使用中と見られ「8902: 装置が使用中です」で繋がらなかった。利用者の実作業を
    妨げないよう、これ以上の奪い合い・新規装置名での再試行はしなかった
    （新規装置名は自動構成が効かないリスクもある。`scripts/README.md`）。
    この部分は`vue-tsc`＋ユニットテスト（`MessageQuickView`10件・`StatusBar`
    クリック連動2件・`EmbedApp`のsystemRef伝播1件）の範囲で裏付けている
    ——「未検証の穴」に明記する。
- **影響**: `vscode-extension/src/ts5250EditorProvider.ts`・
  `packages/web-ui/src/EmbedApp.vue`・`packages/web-ui/src/components/
  StatusBar.vue`・`packages/web-ui/src/components/MessagePane.vue`
  （副次的なバグ修正）を変更。`packages/web-ui/src/components/
  MessageQuickView.vue`を新設。関連テストを追加。同じPR #414（未マージ）へ
  追加コミットする。

## D13: 通常のブラウザ版でのメッセージクイックビューを実機で確認、`openConfigured.ts`のsignonUser欠落を発見・修正

- **背景**: D12納品後、利用者から「通常のブラウザ版エミュレータも対応出来ていますか？」と
  質問された。コード上は`packages/web-ui/src/composables/openConfigured.ts`が元から
  `openSession()`へ`s.system`（`systemRef`）を渡していたため「対応済みのはず」と回答したが、
  D12の「未検証の穴」（実ブラウザでのUI一気通貫が未達）をそのまま残していたので、
  PUB400（利用者の実作業中のSR-OSAKA/AS01とは無関係な装置`MARO`）で実際に確かめた。
- **確認できたこと**: ランチャーから「接続」→ 5250画面が開く → ステータスバーに
  「✉ メッセージあり」が実際に表示される → クリックすると`MessageQuickView`の
  ポップオーバーが開き、実メッセージ（`メッセージ（QSYSOPR）`）が表示された。
  ここまではD12の実装どおり動作した。
- **利用者からの追加の質問**: 「このメッセージはジョブのMSGQに送信されたものですか？」。
  推測で答えず、実機のSQL（`QSYS2.MESSAGE_QUEUE_INFO`）を`MARO`（自分の待ち行列）と
  `QSYSOPR`の両方に対して直接クエリし比較した。
  - `MARO`（自分の待ち行列）: 1件——`"System is scheduled to be powered off at
    08:00:00 on 26-09-20." from=QPGMR/QSYSSCD`。MW灯を点けた張本人と考えて矛盾しない、
    自分宛ての具体的な内容。
  - `QSYSOPR`: 10件——`JOBMANAGER`/`LONGDM`/`#SYSLOAD`等、**自分とは無関係な他ジョブの
    システムメッセージ**（PUB400は多人数が共有する公開機で、QSYSOPRは絶えず動いている）。
  - ポップオーバーが表示していたのは**QSYSOPRの方**——つまり**ジョブ/利用者自身の
    MSGQではなく、無関係な共有待ち行列を見せていた**。利用者への回答は「いいえ、
    このケースでは違った」。
- **根本原因**: `MessageQuickView.vue`の`queue()`は`props.defaultQueue`が空なら
  `QSYSOPR`へフォールバックする設計（`MessagePane.vue`と同じ既定）。`defaultQueue`は
  `StatusBar.vue`経由で`state.meta?.signonUser`から来るが、**`openConfigured.ts`の
  `meta`構築にはそもそも`signonUser`が無かった**——D12で`EmbedApp.vue`（VSCode拡張の
  直接接続経路）には追加したが、**通常のブラウザ版のランチャー経由接続
  （`openConfigured.ts`。`LauncherPane.vue`/`ServicesPane.vue`が共通で使う唯一の
  接続経路）には追加し忘れていた**。
- **決定**: `packages/web-ui/src/composables/openConfigured.ts`の`meta`に、
  `systemsStore.systems`から引いた`signonUser`（分かるときだけ）を追加する
  （`packages/web-ui/src/composables/openConfigured.ts:125-138`）。
  - `signonUser`は`PublicSystem`の既存フィールドで、個人設定（`own:`）は常に、
    サーバー設定（`srv:`）はeditor（admin/認証オフ）のときだけサーバーから返る
    （`packages/server/src/config-resolver.ts:288-291`の`includeSignon`）。
    一般ユーザーが`srv:`システムを開く場合は今回も`undefined`のままで、
    その場合は従来どおり`QSYSOPR`へフォールバックする（改善の余地はあるが、
    ブラウザ側に手掛かりが無い以上これ以上の推測はしない——実装済みの
    フォールバック自体はD12からの既存仕様）。
- **検証**: `packages/web-ui/test/open-configured-signon-user.test.ts`を新設
  （2件）。mutationで検証済み（`sys?.signonUser`の付加を外すと1件目が実際に
  落ちることを確認してから戻した）。`packages/web-ui`全体のテスト（209ファイル・
  2685件）green。`npm run build -w @ts5250/web-ui`（`vue-tsc -b`＋`vite build`）green。
- **影響**: `packages/web-ui/src/composables/openConfigured.ts`を変更（1箇所）。
  `LauncherPane.vue`・`ServicesPane.vue`のどちらから開いても同じ経路なので、
  両方に反映される。VSCode拡張（`EmbedApp.vue`）は既にD12で対応済みで無変更。
  同じPR #414（未マージ）へ追加コミットする。

## D14: VSCode版に「⬇ HTML」ボタンを追加、設定画面を拡充（端末の種類/画面サイズ/CCSID）

- **背景**: 利用者から3点の要望——(1) VSCode版にHTMLダウンロードボタンを追加、
  (2) 設定画面で設定できる項目を充実させる、(3) CCSIDはドロップダウンから選択させる。
- **調査で判明した事実**（推測で設計しない。AGENTS.md「判断の原則」2.）:
  - `App.vue`（通常のブラウザ版）は`⬇ HTML`ボタンを持つが、`EmbedApp.vue`（VSCode拡張）
    には**そもそも無かった**——単純な機能欠落。
  - `.ts5250`ファイルのスキーマ（`vscode-extension/src/schema.ts`の`Ts5250File`）は
    `katakanaVariant`/`terminal`/`screenSize`/`ifsPath`/`sqlInitial`を既に持ち、
    読み込み側（`buildConnectPayload`）も既に配線済みだったが、**書き込み側
    （`SettingsForm.vue`・`handleSave`）には一度も繋がれていなかった**——手でJSONを
    直接編集しない限り使えない項目だった。
  - `enhanced`（拡張5250 GUI広告）は`packages/tn5250/src/protocol/query-reply.ts:45`で
    `void enhanced; // ACS実機と同じ申告に統一する（拡張は常に広告する）`と、**プロトコル層で
    既に無視される値**と判明。UIに出すと「設定しても効かない」項目を足すことになるため、
    今回のフォーム拡充からは**意図的に除外した**。
  - `ifsPath`/`sqlInitial`は`ConnectPayload`に値は乗るが、**`IfsPane.vue`/`SqlPane.vue`が
    そもそも初期パス/初期クエリのpropsを持たない**——値を保存しても何も起きない死んだ項目。
    これも今回のフォーム拡充からは除外した（非機能なUIを足すのは利用者に誤解を与える）。
  - CCSIDは自由入力の数値欄ではなく、`ConfigCard.vue`（通常版のシステム/セッション編集）が
    既に使っている**「ホストコードページ」1本のドロップダウン**（`hostCodePages.ts`の
    `HOST_CODE_PAGE_OPTIONS`。ACSの接続設定画面の一覧に倣う。930はKatakana/Katakana
    Extendedの2エントリを持つ）がこのPJの既存の確立パターンだったので、それをそのまま
    再利用した（CCSIDと`katakanaVariant`を独立した2つの欄に分けない）。
- **決定**:
  1. **`EmbedApp.vue`**: ヘッダーに`⬇ HTML`ボタンを追加（`app === 'emulator' &&
     sessionId`のときだけ）。`screenExport.ts`の`downloadScreenHtml()`をそのまま呼ぶ
     （サーバーへ往復しない。`App.vue`と同じ実装を再利用、複製しない）。
  2. **`SettingsForm.vue`**: `app: EmbedAppKind`を必須propに追加。
     - CCSID欄を`HOST_CODE_PAGE_OPTIONS`の`<select>`へ置き換え（「未指定（既定）」＋
       ACSの一覧と同じ選択肢）。930の2エントリは`ccsid`と`katakanaVariant`の両方を
       1回の選択で決める。
     - `端末の種類`（5250/3270）・`画面サイズ`（24x80/27x132）・`装置名`は
       `app === 'emulator'`のときだけ表示する（emulatorのみ意味を持つ、という
       `ConnectPayload`の既存ドキュメント注記に合わせる。以前は`装置名`が全app種別で
       無条件表示されていたのも合わせて是正した）。
     - `端末の種類`が`3270`のときは`画面サイズ`欄を出さず、保存時も送らない
       （3270はモデルで決まる。`.ts5250`はモデル指定を持たないため今回は追加しない
       ——スコープを広げすぎない）。
  3. **`embed-protocol.ts`/`protocol.ts`**（手で同期を保つ複製。`paired-artifact-sync`
     条項）: `SettingsFormValues`に`katakanaVariant`/`terminal`/`screenSize`を追加。
     **両ファイルへ同一の差分を適用**し、`protocol-sync.test.ts`（型定義部分の一字一句比較）
     で機械的に固定した。
  4. **`ts5250EditorProvider.ts`の`handleSave`**: 新しい3フィールドを`.ts5250`へ
     書き戻す分岐を追加（読み込み側`buildConnectPayload`は既存のまま無変更で足りた）。
  5. **`webviewHtml.ts`**: `<iframe>`の`sandbox`に`allow-downloads`を追加。
     **Playwrightで最小再現して確認**——sandbox化された`<iframe>`はこのトークンが
     無いとBlob URL経由の`<a download>`クリックを黙ってブロックする（Chromiumの仕様。
     トークン有無でPlaywrightの`download`イベントの発火/非発火を確認した）。`local-fonts`
     （D8）と同様、**VSCode拡張の`Webview`自体がさらに上位でダウンロードを許可しているかは
     実際の拡張ホストが無いこの開発環境では確認できていない**。
- **点検で見つけて直した副次的な問題**:
  - `SettingsForm.vue`のフォーカストラップ（`onKeydown`）の`querySelectorAll`が
    `input`/`button`しか拾わず`select`を含んでいなかった。今回`<select>`を複数追加した
    ため`select`もクエリへ足した。**ただし現在のフィールド順では先頭（ホスト欄）と
    末尾（保存/キャンセルボタン）がどちらも元から`focusables`に含まれていたため、
    mutationで確認したところこの追加は現状のDOM順では観測可能な効果を持たない**
    （host入力が常に先頭、ボタンが常に末尾）——将来フィールド順を入れ替えたときの
    予防的な正しさとして残すが、「バグを直した」と誇張しない。この事実確認のために
    書いた専用テストは、mutationで無意味と分かったため削除した。
- **review工程で見つけて直した問題**: CCSIDドロップダウンで一覧に無い値
  （5026/5035等）を、他の項目だけ変えて保存しても黙って消してしまう不具合
  （`codePageId`が"unset"のまま`handleSave`の`else delete next.ccsid`が働くため）。
  `unrecognizedCcsid`で「一覧には無いが元は指定されていた値」を保持し、選び直されない
  限り温存するよう修正した。mutationで検証済み（修正を外すと新設テストが実際にfail
  することを確認してから復元）。詳細は`review.md`ラウンド13。
- **検証**:
  - mutation検証: `allow-downloads`を外すと`webviewHtml.test.ts`が実際に2件failすることを
    確認してから復元（Chromiumのsandbox仕様どおり）。
  - `vscode-extension`: `tsc -b`＋`tsc -b tsconfig.test.json`（0 errors）・
    `npx vitest run`（76 passed / 13 files）・`npx eslint`（変更ファイル、0 errors）。
  - `packages/web-ui`: `npm run build -w @ts5250/web-ui`（`vue-tsc -b`＋`vite build`）green・
    `npx vitest run`（**2700 passed**／209 files。新規15件——`settings-form.test.ts`10件
    ＋`embed-app.test.ts`5件）。
  - **実ブラウザでの一気通貫（Playwright）**: ビルド済み`dist`を一時サーバーで配信し、
    `embed.html?app=emulator`と`?app=sql`の両方で設定画面を実際に開いてスクリーンショット
    で確認。emulatorでは端末の種類/画面サイズ/装置名/ホストコードページが揃って表示、
    sqlでは3項目が正しく隠れることを確認。CCSIDドロップダウンで930拡張カタカナを選択→
    端末の種類を3270に切替→画面サイズ欄が実際に消えることも確認。ラベル幅が狭く
    「ホストコードページ」が2行に折り返す表示崩れを実際に見つけ、`8em`→`9.5em`＋
    `white-space:nowrap`で修正して再確認した。
  - **HTMLダウンロードボタンの実クリック→実ダウンロードの一気通貫（実際のVSCode拡張
    ホスト経由）は未検証**——このコンテナに拡張ホストが無いため（既存の制約。
    `test-result.md`の「未検証の穴」に記載済みパターンと同じ）。`allow-downloads`の
    必要性自体はPlaywrightでの最小再現で実証済みだが、VSCode WebView自体がこれを
    上位で許可するかは未確認のまま残す。
- **影響**: `packages/web-ui/src/EmbedApp.vue`・`packages/web-ui/src/components/
  SettingsForm.vue`・`packages/web-ui/src/embed-protocol.ts`・
  `vscode-extension/src/protocol.ts`・`vscode-extension/src/ts5250EditorProvider.ts`・
  `vscode-extension/src/webviewHtml.ts`を変更。関連テスト4ファイルを更新。
  同じPR #414（未マージ）へ追加コミットする。

## D15: `.vsix`ビルドスクリプト（`vscode-extension.sh`/`.bat`）を新設

- **背景**: 利用者から「vsixのビルドshとbatを作って」との要望。それまでは
  `node vscode-extension/scripts/prepare-server.mjs && npx --yes @vscode/vsce package`
  を手で（かつ事前に`npm run build`/`npm run build -w @ts5250/web-ui`/
  `vscode-extension`側の`npm install`/`npm run build`も別途手で）打つ必要があった。
- **既存資産の調査**（推測で書き始めない）: リポジトリ直下に同種のランチャー対
  `start.sh`/`start.bat`（Webアプリ起動）・`electron.sh`/`electron.bat`
  （Electronデスクトップ版のインストーラ生成）が既にあり、**どちらも同じ構造**
  （Node版チェック→ワークスペース依存の鮮度判定→未ビルド/`--build`指定時だけ
  ビルド→サブプロジェクト固有の依存/生成）を持つ。この構造は`launcher/
  preflight.mjs`（`--check-node`/`--needs-build`）に集約されており、
  冒頭コメントに「`start`/`electron`の4つのランチャーから共通で呼ぶ」と明記されていた。
  **車輪の再発明をせず、この対に3本目として乗せる**のが妥当と判断した。
- **決定**:
  1. `vscode-extension.sh`/`vscode-extension.bat`をリポジトリ直下に新設
     （`electron.sh`/`.bat`と同じ命名規則——対象のサブプロジェクトディレクトリ名）。
     `electron.sh`/`.bat`の構造をそのまま踏襲し、末尾に拡張機能固有の3手順
     （`vscode-extension`の依存インストール（存在チェックのみ。既存の`electron/
     node_modules`チェックと同じ簡潔さ）→ビルド→`prepare-server.mjs`→
     `vsce package`）を追加した。
  2. `--build`で強制再ビルド、無指定なら`preflight.mjs --needs-build`で鮮度判定
     （`start`/`electron`と同じ既定動作。パッケージング用途だからといって
     「常に非条件でフルビルド」にはせず、既存の判断を再利用した）。
  3. `.bat`はASCIIのみで書く（cp932コンソールでの多バイト文字誤読を避ける。
     `start.bat`/`electron.bat`冒頭の既存コメントと同じ理由・同じ制約）。
  4. `launcher/preflight.mjs`冒頭のdocコメント「`start`/`electronの4つのランチャー`」
     を「`start`/`electron`/`vscode-extensionの6つのランチャー`」へ更新した
     ——呼び出し元が増えたのにコメントの数字だけ古いままだと、次にここを読む人が
     実際の呼び出し元を把握し損なう（記述と実体の食い違いを放置しない。
     AGENTS.md「判断の原則」3の精神——気づいた食い違いはその場で直す）。
- **検証**: 実際に`./vscode-extension.sh`（既定・鮮度判定でビルドをスキップする経路）
  と`./vscode-extension.sh --build`（強制ビルド経路）の両方を実行し、どちらも
  `vscode-extension/ts5250-vscode-0.1.0.vsix`（3916ファイル・10.41MB）を実際に
  生成することを確認した。`.bat`は**このLinuxコンテナでは実行できないため
  未検証**——`electron.bat`/`start.bat`の実証済みの構造を一字一句に近い形で
  踏襲することで確からしさを担保しているが、実際のWindows上での動作確認は
  利用者に委ねる（`decisions.md` D8/D14と同種の、環境起因の限界）。
- **影響**: `vscode-extension.sh`（新規）・`vscode-extension.bat`（新規）・
  `launcher/preflight.mjs`（コメント更新のみ、ロジック変更なし）を変更。
  同じPR #414（未マージ）へ追加コミットする。

## D16: 設定画面に「splash」（ウォーターマーク＝画面に重ねる透かし）を追加

- **背景**: 利用者から「設定にsplashの設定も追加して」との要望。コードベースに
  「splash」という既存の概念が見当たらなかったため、推測で実装せず
  `AskUserQuestion`で確認した——回答は「エミュレータ背景にホスト名や任意の文字列
  などを表示する、通常版のエミュレータは既に持っている機能のこと」。これは
  `packages/server/src/config-types.ts`の`watermarkSchema`（ウォーターマーク。
  ACSの透かしと同じ用途——本番機と検証機を一目で見分ける）そのものだった。
- **調査で判明した、この機能特有の難所**（推測で設計しない）:
  - **保存元がD14までの他フィールドと根本的に違う。** `EmulatorPane.vue`の
    `watermarkConfig`は`state.configRef`（保存済みセッション設定への参照）から
    `systemsStore.sessions`を引く——`ConnectPayload`/`SessionMeta`を経由しない。
    VSCode拡張のemulatorは直接接続（`configRef`を持たない）なので、既存の
    参照経路では最初から透かしを描けない構造だった。
  - **`ConfigCard.vue`の`wmForm`は7項目を持つ**（文字/表示/配置/濃さ/大きさ/角度/色）。
    「splash」という漠然とした要望から機能の輪郭を絞り込むため、通常版の
    実装をそのまま読んで移植の範囲を決めた（新規に何かを発明しない）。
- **決定**:
  1. **`EmulatorPane.vue`の`watermarkConfig`にフォールバックを追加**——
     `configRef`経由の値が無ければ`state.meta?.watermark`を見る。既存の
     保存済みセッション設定経由の経路は変えず（`configRef`があれば従来どおりそちら優先）、
     直接接続だけの新しい経路を**追加**した（`packages/web-ui/src/components/
     EmulatorPane.vue:65-73`）。
  2. **`SessionMeta`（`stores/sessions.ts`）に`watermark?: Watermark`を追加**——
     `configRef`を持たないセッション専用の持ち回り先。
  3. **`embed-protocol.ts`/`protocol.ts`**（手で同期を保つ複製）: `WatermarkValue`
     インライン型（`@ts5250/server`の`Watermark`と同じ形だが、拡張機能側が
     `@ts5250/server`をimportできないため意図的にインライン定義）を新設し、
     `ConnectPayload`/`SettingsFormValues`へ`watermark?: WatermarkValue`
     （emulatorのみ）を追加。両ファイルへ同一差分を適用し`protocol-sync.test.ts`
     （型定義部分の一字一句比較）で機械的に固定した。
  4. **`schema.ts`（`Ts5250File`）・`ts5250EditorProvider.ts`**（`buildConnectPayload`/
     `handleSave`）に読み書きを追加——D14で確立した「分かるときだけ付与、
     無ければ`delete`」パターンをそのまま踏襲。
  5. **`SettingsForm.vue`**: `ConfigCard.vue`の`wmForm`/`loadWatermark`/`clamp`/
     `buildWatermark`をそのまま移植（ロジック・既定値・範囲・「文字が空なら
     設定ごと無し」という判断を含めて同一）。emulatorのみ・文字を入れて初めて
     細かい見え方の欄を出す、という表示順序も`ConfigCard.vue`と揃えた。
- **review工程で見つけて直した問題（must）**: `resolveWatermark()`
  （`composables/watermark.ts`）は`cfg.text`が文字列であることを前提に
  `.replace()`を呼んでおり、**サーバー設定・個人設定経由（`watermarkSchema`で
  `text`必須を保証）では届かない壊れた値**を素通しで受け取る前提だった。
  `.ts5250`ファイル（`vscode-extension/src/schema.ts`）は「JSONとして読めるか」
  以外を検証しない設計のため、手編集で`"watermark": {}`のような値を書くと
  `EmulatorPane`ごと例外で描画不能になることを実際に再現して確認した
  （`resolveWatermark({})`で`TypeError: Cannot read properties of undefined
  (reading 'replace')`）。`typeof cfg.text !== "string"`を弾く1行を追加して
  「表示しない」へ安全に倒し、mutationで検証済み（外すと新設テストが実際に
  同じ例外でfailすることを確認してから復元）。この修正は`watermark.ts`という
  main appとVSCode拡張の両方が使う共有関数への修正なので、main app側の
  既存の安全性には影響しない（サーバー側は元々zod検証済みで、この分岐に
  到達しない）。
- **検証**:
  - mutation検証2件（`resolveWatermark`のtext型ガード／`EmulatorPane.vue`の
    metaフォールバック／`SettingsForm.vue`のsave()配線——実質3件、いずれも
    「外す→実際にfailを確認→復元」の手順を踏んだ）。
  - `vscode-extension`: `tsc -b`×2・`vitest run`（76 passed）・eslint 0 errors。
  - `packages/web-ui`: `vue-tsc -b`＋`vite build`green・`vitest run`
    （**2712 passed**／210 files。新規21件——`settings-form.test.ts`に9件、
    `embed-app.test.ts`に2件、新設`emulator-pane-watermark.test.ts`に4件、
    `watermark.test.ts`に1件のクラッシュ回帰）。
  - **実ブラウザでの確認（Playwright）**: `embed.html?app=emulator`の設定画面で
    透かし文字欄・細かい見え方の欄の出し分けをスクリーンショットで確認。
  - **実機での一気通貫（Playwright、PUB400）**: `.ts5250`相当のconnectペイロード
    （`watermark: { text: "PUB400 {host}", layout: "center", size: 40 }`）で
    実際に接続し、`EmulatorPane`内に`.wm`要素が実際に生成され、差し込み変数
    `{host}`が実際のホスト名（`pub400.com`）へ展開された状態
    （`"PUB400 pub400.com"`）でDOMに現れることを確認した。
- **影響**: `packages/web-ui/src/components/EmulatorPane.vue`・
  `packages/web-ui/src/components/SettingsForm.vue`・
  `packages/web-ui/src/composables/watermark.ts`（クラッシュ修正）・
  `packages/web-ui/src/stores/sessions.ts`・`packages/web-ui/src/embed-protocol.ts`・
  `vscode-extension/src/protocol.ts`・`vscode-extension/src/schema.ts`・
  `vscode-extension/src/ts5250EditorProvider.ts`を変更。関連テストを新設・拡充。
  同じPR #414（未マージ）へ追加コミットする。

## D17: `.ts5250`を開いても自動接続しない——明示的な「接続」「切断」ボタンにする

- **背景**: 利用者から「`.ts5250`ファイルを開くと即座に接続するので、設定だけを変えたい場合にも
  接続されてしまう。接続は接続ボタンを明示的にクリックするようにする。切断はファイルを閉じればOKか？
  明示的な切断ボタンを作っても良い」との要望・質問。PR #414（マージ済み）の後続作業のため、
  新ブランチ`feature/vscode-extension-explicit-connect`で行った。
- **調査で判明した事実**（推測で答えない）:
  - 自動接続の発生源は2つあった: (1) WebViewの`ready`に拡張ホストが即`connect`を返していた
    （`ts5250EditorProvider.ts`）、(2) 設定保存後の`saved`も`embedStore.connect`を書き換えており、
    `EmbedApp.vue`のwatchが**保存のたびに再接続**していた。さらに(1)(2)とも`syncSystem`
    （サーバーへの個人設定登録）まで走っていた——「開いただけ」「保存しただけ」でサーバー側の状態が変わっていた。
  - **「ファイルを閉じれば切断」は即時ではない**。閉じるとWebSocketが明示的な`close`無しに落ち、
    サーバーは「転送断」として扱い再接続の猶予（`DEFAULT_RECONNECT_GRACE_MS = 90_000`。
    `packages/server/src/session-manager.ts:128`、判定は`session-lifetime.ts`の`decideDisposition`）の間
    セッション＝装置を保持する。**PUB400で実測**: 閉じて2/30/60秒後はサーバーのセッション数1、95秒後に0。
    一方、`closeSession()`（`{type:"close"}`を送る）なら即座に0になる——明示的な切断ボタンには実益がある。
- **決定**:
  1. **プロトコル**（`embed-protocol.ts`/`protocol.ts`。手で同期を保つ複製、`protocol-sync.test.ts`で固定）:
     拡張→WebViewに`loaded`（表示・設定フォーム初期値用、接続しない）を追加。WebView→拡張に
     `{type:"connect"}`（接続ボタン押下。payload無し）を追加。
  2. **`ts5250EditorProvider.ts`**: `ready`→`sendLoaded`（`buildDisplayPayload`。**`syncSystem`を呼ばない**）。
     `connect`要求→従来の`sendConnect`（`resolvePayload`で`syncSystem`まで解決）。`handleSave`も
     `buildDisplayPayload`で`saved`を返し`syncSystem`を呼ばない（不要になった`localPort`引数を削除）。
     `buildDisplayPayload`は**emulator以外のuser/passwordを剥離する**——`syncSystem`経路（`resolvePayload`）が
     担っていた剥離をこちらでも行わないと、平文がWebViewへ漏れる（taskcheck T2の不変条件を維持）。
  3. **`stores/embed.ts`**: `loaded`フィールドを新設。`loaded`/`saved`は`embedStore.loaded`だけを更新し
     `connect`に触らない。`connect`だけが`embedStore.connect`（＝実接続の合図）を立てる。
  4. **`EmbedApp.vue`**: 待機表示にホスト名と「接続」ボタン（ホスト未設定なら無効）。接続中はヘッダーに
     「切断」ボタン——emulatorは`closeSession()`、printer/sql/ifsは`embedStore.connect`を空にしてペインを
     アンマウント。設定フォームの初期値は`connect ?? loaded`。
  5. **接続中に設定を保存しても自動再接続しない**——新しい設定は「切断」→「接続」で反映する
     （「明示的な操作でだけ接続が変わる」を一貫させる）。
- **検証**:
  - mutation 2件: `saved`/`loaded`が`connect`も立てる旧挙動へ戻すと`embed-store.test.ts`3件がfail／
    `disconnect()`を空にすると`embed-app.test.ts`の切断2件がfail——いずれも確認後に復元。
  - `vscode-extension` 80 passed（`serviceManager.integration.test.ts`が全体実行時に1回だけ起動タイムアウト、
    単独再実行・全体再実行とも成功——実プロセスを起こす既存テストの環境依存の揺れで本変更と無関係）。
    `packages/web-ui` 2723 passed。`vue-tsc`/`tsc -b`/`vite build` green。
  - **実機（PUB400、Playwright＋shell中継を模した最小shell）**: 開いた直後 送信=`[ready]`・サーバーの
    セッション数0・接続ボタンあり → 接続 → セッション数1・切断ボタンあり → 切断 → **即座に**セッション数0・
    接続ボタンに戻る。別途「切断を押さずタブを閉じる」と95秒後まで1のまま（上記）。
- **影響**: `packages/web-ui/src/{EmbedApp.vue,embed-protocol.ts,stores/embed.ts}`・
  `vscode-extension/src/{protocol.ts,ts5250EditorProvider.ts}`と関連テスト3ファイル。

## D18: VSCode版のIFS/SQLが画面幅を使えていない問題を直し、IFSの列境界をドラッグで動かせるようにする

- **背景**: 利用者から「IFSは画面全体を活用できておらず右側が空いている」「フォルダ一覧・ファイル一覧・
  表示の間をD&Dでリサイズしたい」「SQLは縦スクロールバーと画面全体の横スクロールバーが出る。横に長い
  結果は結果ビューの横スクロールバーが機能するべき」との報告（スクリーンショット付き）。
- **原因（実測。PUB400でSQL/IFSペインを実際に開いてPlaywrightで計測）**:
  `EmbedApp.vue`の`.embed-body`が行方向のflexで、ペイン（子）に`flex:1`も`min-width:0`も無かった。
  行方向のflexの子は内容幅になる——**IFSは1200px中652px**しか使わず右が空き、**SQLは横に長い結果
  （`SELECT * FROM QSYS2.SYSTABLES`）でペインが4420pxまで膨らみ**ページ全体が横スクロールしていた
  （結果グリッド自身の`overflow`が効かない）。本来のアプリは`.pane-slot`（ブロック要素）に載せるので
  この問題が起きない。縦スクロールバーはheadless Chromiumでは単独に再現できなかった（スクロールバーが
  場所を取らない）が、ページの横スクロールバーが高さを食うことによる二次的なものと判断——修正後は
  ページが窓とちょうど同じ大きさになる。
- **決定**:
  1. `EmbedApp.vue`: `.embed-body > * { flex: 1 1 auto; min-width: 0; min-height: 0; }`。
  2. 既存の`usePaneSplit`＋`PaneSplitter`（SQL／スプールの上下の境界）に左右向き（`axis:"x"` /
     `vertical`）を足し、IFSの「フォルダ一覧｜ファイル一覧｜表示」に2本の境界を置いた（表示は残り幅）。
     別の部品を作らない——同じ掴み方・同じキー操作（左右キー）にするため。`topHeight`は幅にも使うので
     `size`へ改名（呼び出し元はSqlPane/SpoolPaneの2か所）。
  3. IfsPaneは本来のアプリと共用なので、境界ドラッグは本来のアプリのIFSでも使える。
- **検証**:
  - 実測（修正前→後、1200×700）: IFSペイン幅 652→1200、SQLペイン幅 4420→1200、ページのscrollWidth
    4420→1200。修正後SQLの結果グリッド（`.rows-scroll`）は内容4230px/表示1006pxで**自身が**横スクロール。
    450px高でもページのscrollHeight＝窓の高さ（縦にはみ出さない）。
  - 実機でIFSの境界をドラッグ: 各列幅 [220,380,598] → 左の境界を+120 → [340,380,478] →
    右の境界を−150 → [340,230,628]。
  - 新設`pane-split.test.ts`（5件、`usePaneSplit`/`PaneSplitter`は従来テストが無かった）。mutation:
    `axis`を無視させると3件fail（キーボードのテストは当初すり抜けたので、キー1回ごとに確かめる形へ直した）。
  - `packages/web-ui` 2731 passed。`vscode-extension` 80 passed（無変更。実プロセスを起こす統合テストが
    1回揺れたが再実行で成功——D17と同じ既知の揺れ）。

## D19: 接続を持たない種類は「開く」だけにし、待機表示に「何の機能か」を、emulatorのヘッダー左に名前とⓘを出す

- **背景**: 利用者の質問「スプール等、取得時に接続しており明示的な接続・切断が本来不要なものはあるか」に、
  サーバーの実装を読んで答えた——**常時の接続を持つのはemulatorだけ**。スプール（`host-spools.ts`）とIFS
  （`host-ifs.ts`）は操作ごとに接続して`finally`で閉じる。SQLは`db-pool.ts`がサーバー側で接続を温存し
  （アイドル5分、鍵は資格情報単位でタブ単位ではない）、ページング用のカーソルを`result-set-store.ts`が
  保持する（アイドル60秒、ペインのアンマウントで解放）。したがってそれらの「切断」は画面を閉じるだけだった。
  利用者の判断で次の3点を実施:
  1. emulatorは「接続／切断」のまま、スプール・SQL・IFSは「切断」を無くし「接続」を「開く」に。
     **「開く」自体は残す**——開いた瞬間にペインがホストへ一覧を取りに行くので、無くすと「設定だけ直したい
     のに取得が走る」（D17の要望）が再発する。
  2. 待機表示にボタンだけでなく情報を出す（種類・説明・設定名・ホスト・TLS・ユーザー・CCSID、emulatorは
     装置名・画面サイズ）。種類と説明はランチャーのカードと同じ文言——`LauncherPane.vue`の`FEATURES`を
     `src/features.ts`へ切り出して共有した（写すと片方だけ直る）。
  3. emulatorのヘッダー左に、本来のアプリのタブと同じ「名前＋ⓘ（`SessionInfo`）」を置く。
- **名前**: 本来のアプリのタブ名はセッション設定の名前だが`.ts5250`には無い。**ファイル名（拡張子なし）**を
  `ConnectPayload.title`として拡張ホストが`loaded`/`connect`/`saved`に付ける（`syncSystem`が登録する
  システム名もファイル名なので呼び名が揃う）。これまで`openSession`のlabelは固定の`"embed"`だった。
  ⓘに出す情報のため、`meta`に`port`/`tls`/`ccsid`/`screenSize`/`autoSignon`（パスワードがあれば）も載せた。
- **見つけて直した既存の不具合**: 設定フォームのTLSが`props.initial?.tls ?? true`だった。サーバーは
  `tls === true`のときだけTLSにする（`ws-handler.ts`）ので、`tls`を書いていないファイルを開くとチェックが
  入り、**別の項目だけ変えて保存しても`"tls": true`が書かれ、黙ってTLS接続に変わっていた**。本来のアプリも
  既存の編集は`s.tls ?? false`（`ConfigCard.vue:343`）なので`?? false`に揃えた。待機表示も未指定を「無効」と出す。
- **検証**: `packages/web-ui` 2740 passed・`vscode-extension` 81 passed。mutation: TLS既定を`?? true`に
  戻す→2件fail、`loaded`から`title`を外す→1件fail（いずれも復元）。実機（PUB400）でemulatorに接続し、
  ヘッダー左に`sample-emu`とⓘ、ⓘで本来のアプリと同じ情報（種別・ホスト・CCSID・画面・デバイス名・
  自動サインオン・ジョブ…）が出ることをスクリーンショットで確認。スプールの待機表示もスクリーンショットで確認。

## D20: VSCode拡張にプリンターセッション（`app: "printer"`）を追加し、スプール表示を`app: "spool"`へ改名

- **背景**: 利用者の要望「VSCode拡張機能にプリンターセッションも追加して」。既存の`app: "printer"`は
  実は**スプール表示**（`SpoolPane`）を指しており、本来のアプリの呼び名（「プリンター」＝プリンターセッション、
  「スプール」＝既存スプールの一覧）と食い違っていた。利用者の判断（`AskUserQuestion`）で
  **`printer`をプリンターセッションに、スプール表示を`spool`に改名**した。拡張は未公開なので影響は手元の
  ファイルだけ——サンプルは`sample-printer.ts5250`→`sample-spool.ts5250`へ改め、新しい
  `sample-printer.ts5250`（装置名`PRT_ASAO`）を作った。
- **調査で判明した事実**: サーバーはプリンターの**直接接続**（host/port/ccsid/装置名/TLS/user/password）を
  受け付ける（`ws-handler.ts`の`onOpenPrinter`）。出力設定（自動PDF・自動印刷）は信頼設定なので直接接続の経路では
  受け付けない——`.ts5250`のプリンターは帳票を受けて見るだけ。表示は本来のアプリと同じ`openPrinterSession()`＋
  `PrinterPane`。プリンターは装置を掴むセッションなので**emulatorと同じく「接続／切断」・名前とⓘ**を持つ。
- **決定**:
  1. `EmbedAppKind`に`spool`を追加（`printer`の意味を変更）。`schema.ts`/`stores/embed.ts`の許可リストも更新。
  2. `ts5250EditorProvider.ts`: 資格情報をWebViewへ渡す判定を「emulatorか」から`isSessionApp`（emulator・printer）へ。
     プリンターも`WsOpen`へuser/passwordを直接渡すため。
  3. `EmbedApp.vue`: `isSession`で接続／切断・名前とⓘ・待機表示のボタン名（接続／開く）を分岐。printerは
     `kind:"printer"`で`openPrinterSession()`（emulator専用の端末種別・画面サイズ等は送らない）、`meta.sessionType`
     を`printer`に。`⚙ 表示`は帳票向け項目（`REPORT_VIEW_KEYS`）をセッションIDで。⬇HTMLはemulatorだけ。
  4. 待機表示: 種類「プリンター」・説明。装置名が未設定なら「未設定（自動構成をホストが許す場合のみ）」と出す
     ——多くのホストはプリンター装置の自動構成を断る（`8940`。`scripts/research-msgw.mjs`）。
  5. 設定フォーム: printerは装置名だけ出す（端末の種類・画面サイズ・透かしは画面のもの）。
- **検証**:
  - `packages/web-ui` 2745 passed・`vscode-extension` 82 passed。mutation: `isSessionApp`をemulatorだけに戻す→
    プリンターの資格情報テストがfail（復元確認済み）。
  - **実機**（利用者のホスト・PUB400、Playwright＋shell中継を模した最小shell）: 待機表示「プリンター／接続」→
    接続でサーバーのセッション数1・ヘッダーに`sample-printer`とⓘ・切断ボタン有り・⬇HTML無し→切断で0。
  - **帳票の受信までは確認できなかった**（未検証の穴）。`CHGJOB OUTQ(装置)`＋`DSPLIBL OUTPUT(*PRINT)`で
    スプールを作っても両ホストで`READY`のまま、ライター無し（`OUTPUT_QUEUE_INFO`: `NUMBER_OF_WRITERS=0`）。
    **対照実験として本来のアプリ（保存済みのプリンター設定）でも同じ条件で受信0件**だった——VSCode側の配線ではなく
    環境（プリンターセッションを繋いでもライターが上がらない。`scripts/README.md`の既知の注意「`STRPRTWTR`が要る」と同じ）。
    PUB400はライターを常駐させる権限が無い（`CPF3464`。`scripts/research-msgw.mjs`）。セッション中の
    `STRPRTWTR`は`CPF3310`で通らなかった。作成したテスト用スプール（利用者ホスト3件・PUB400 2件）は削除済み。

## D21: スプールの画面が「5250端末」と名乗る不具合を直し、種別の一覧を1か所にする／前のビルドのサーバーを再利用しない

- **背景**: 利用者の報告「app spoolの接続画面に詳細情報が出るが5250端末になっている」「app emulatorで接続ボタン
  しか出ず詳細情報が出ない」。
- **スプールの原因（再現して確定）**: `embed.ts`の`appParam`が独自の種別一覧（`printer`/`sql`/`ifs`）を持ち、
  D20で`spool`を足したときにここだけ漏れていた。`?app=spool`が`emulator`扱いになり、種類は「5250端末」、
  中身（`loaded`）はスプールのファイル——という食い違いの画面になった。型検査では捕まらない（三項演算子は
  正しい種別を返している）。種別の一覧は**4か所に書き写されていた**（型・`schema.ts`・`stores/embed.ts`・`embed.ts`）。
  → `EMBED_APP_KINDS`（`embed-protocol.ts`/`protocol.ts`。手で同期を保つ複製）を唯一の一覧にし、検証する側は
  全部これを参照する。`appParam`は`stores/embed.ts`の`appKindFromQuery`へ出してテスト可能にし、
  `EMBED_APP_KINDS`の全要素で回すテストを置いた（足しても自動で検査対象に入る）。
- **emulatorの症状は今のビルドでは再現しなかった**: `sample.ts5250`から拡張ホストが作るのと同じ`loaded`で
  表示すると、種類「5250端末」・設定・ホスト・TLS・ユーザー・装置名・画面サイズが正しく出た。報告の見た目
  （ホスト名と接続ボタンだけ）は**情報カードを入れる前（D17/D18）のビルドの画面**そのもの。原因として
  確かめられた事実: `ServiceManager.acquire`は生きている既存サーバーをhealthzだけで再利用し、**どのビルドが
  起動したかを見ていない**。ロック（`globalStorage/service.json`）は拡張を入れ直しても残り、`.vsix`の版数は
  0.1.0のまま中身だけ変わるので、前のビルドのサーバーが生きていれば新しい拡張から古い画面が出る。
  **これが今回の原因だったかは確かめられていない**（利用者の環境のプロセスを見られない）が、起きうる欠陥なので塞いだ。
  → ロックに`buildId`（同梱の`main.js`と`embed.html`の中身のハッシュ。`embed.html`はViteのハッシュ付き資産名を
  含むのでWeb UIが変われば必ず変わる）を記録し、違えば古いサーバーを止めて起動し直す（止めないと孤児になる）。
- **検証**: `packages/web-ui` 2752 passed・`vscode-extension` 84 passed。mutation: `appKindFromQuery`を旧来の
  手書き一覧へ戻す→`?app=spool`のテストがfail／`buildId`を見ずに再利用する→ビルド違いのテストがfail（いずれも復元）。
  ServiceManagerの新テストは`process.kill`をモックし大きなダミーpidで行う（D3の教訓——pid 1へのSIGTERM）。
  5種類のサンプルファイルの待機表示を実画面で確認: emulator=5250端末/printer=プリンター/spool=スプール/
  sql=SQL/ifs=IFS、それぞれ詳細とボタン（接続/開く）が正しい。

## D22: 「接続中…」を横方向でも中央に置く

- **背景**: 利用者の報告「接続中の表示が、高さは中央だが左端に出る」。
- **原因**: D18で足した`.embed-body > * { flex: 1 1 auto }`（ペインに幅いっぱいを与える規則）が、ペインではない
  文言の`<p class="status">`にも掛かっていた。幅いっぱいに伸びるので`margin: auto`の横方向が効かず、文字は左寄せになる
  （縦は交差軸なので`margin: auto`が効いたまま）。
- **決定**: `.status`だけ`flex: 0 1 auto`で打ち消す（後に書かれた同じ詳細度の規則が勝つ）。ペイン側の規則は変えない。
- **検証**: Chromiumで同じCSSを当てて測った（800×600）: 修正前`left 0 / width 800`→修正後`left 368 / width 64`
  （中心400）。縦位置は変わらない（`top 307`）。待機カード（`.status.idle`）は元から中身の幅で中央にあり、見た目は変わらない。

## D23: 設定は待機画面に置いて編集のたびに自動保存し、ヘッダーの⚙（ポップアップ）を廃止する

- **背景**: 利用者の要望——(1)設定画面で編集したら保存されるようにする（明示的なファイル保存が要った）、
  (2)保存後に開き直さないと反映されない、(3)接続後の画面からは即時反映が難しいので、ヘッダーの設定呼び出しは
  廃止して最初の接続画面に設定を置く、(4)ポップアップでの接続情報の編集は廃止する。
- **(1)の原因**: `handleSave`は`WorkspaceEdit`を当てるだけで、文書は未保存（dirty）のまま残っていた。
  → `applyEdit`の後に`document.save()`まで行う。失敗は`saveError`（「ファイルへの書き込みに失敗しました」）。
- **(2)の原因（コードで確かめた事実）**: 設定フォームの初期値は`embedStore.connect ?? embedStore.loaded`で、
  **接続した後は保存しても`connect`（接続時の値）が優先**されて古い値が出ていた。spool/sql/ifsは切断が無いので
  `connect`が消えず、ペインも接続時の`systemRef`のまま。加えて、テキストとして直接書き換えても
  WebViewへ知らせる経路が無かった（`onDidChangeTextDocument`を購読していなかった）。
  → 初期値は`loaded`（ファイルの現在値）だけを見る。拡張ホストは`onDidChangeTextDocument`で`loaded`を送り直す。
- **決定（画面）**: 待機画面のカードに「種類・説明・ファイル名・接続/開くボタン・設定の欄」を置く。ボタンは欄の上
  （欄が多いと下はスクロールしないと見えない。Chromiumで900×420でも見えることを実測）。
  読み取り専用の一覧（ホスト・TLS等の行）は欄と重複するので外した。ヘッダーの⚙と`SettingsForm`のポップアップ
  （バックドロップ・フォーカストラップ・Escape・保存/キャンセル）は廃止。spool/sql/ifsには「閉じる」を置き、
  待機画面（設定）へ戻れるようにした（戻れないと、開いた後に設定を変える手段が無くなる）。
- **自動保存の設計**:
  - `SettingsForm`は値が変わるたびに`change`を出し、`EmbedApp`が400msで間引いて`save`を送る
    （1文字ごとに書くとVSCodeの元に戻す履歴が1文字単位になる）。生成時（初期値の反映）は出さない。
  - ポートが打ちかけの不正値（数字以外・範囲外）の間は保存しない（保存すると`port`が消える）。
  - 「接続」は間引き中の保存を先に送る。拡張ホストは**メッセージを1つずつ順に処理する**ようにした——
    並行に処理すると`save`の`applyEdit`が終わる前に`connect`がファイルを読み、古い設定で繋がる。
  - 自分の書き込みでも`onDidChangeTextDocument`は来る。そのたびに`loaded`を送るとフォームが作り直されて
    入力中の文字が消えるので、**書いた内容と同じなら送らない**。比較はキューの中で行う——通知は`applyEdit`の
    最中に同期的に来るので、その時点では書いた内容の記録がまだ更新されていない（テストで再現してから直した）。
  - フォームは`loadedRev`（`loaded`を受けた回数。`saved`では進まない）を`key`にし、外で書き換えられたときだけ
    作り直す。そのとき間引き中だった古い入力は捨てる（書き換えを上書きしない）。
  - `fileInvalid`で`loaded`を捨て、読めないファイルのときはフォームを出さない——出していると入力1つで
    壊れたファイルを上書きする（保存は既定の`app: "emulator"`を土台にするので、別種別のファイルでも起きる）。
- **退けた案**: 接続中にも設定を開けるようにし、保存したら自動で再接続する——利用者が「即時反映は難しいので
  廃止」と判断済み。接続中の再接続は入力中の画面を失わせるので、明示的な「切断→編集→接続」の方が安全。
- **検証**: web-ui 2758 passed（211 files）・vscode-extension 90中89 passed（落ちた1件は
  `serviceManager.multiprocess.integration.test`の20秒タイムアウト。単独で2回とも合格——全体実行の負荷で遅れる既知の揺れ）。
  mutation 10件すべてfail（キュー無し・`document.save`無し・自己書き込みの比較をキュー外・購読解除無し・接続前の保存送り無し・
  `saved`でも`loadedRev`を進める・生成時に`change`・`fileInvalid`で`loaded`を残す・外の書き換えで間引きを捨てない・
  ポート検査無し）。画面は`vite build`したものをChromiumで表示して確認（下記test-result）。

## D24: 設定の欄を役割で束ねて横に並べ、自動保存の状態を画面に出す

- **背景**: 利用者の指摘——(1)「保存ボタンが無いが、接続・開くボタンで開くと同時に保存されるのか」
  (2)「設定を縦に並べた結果、エミュレータなど欄が多い画面では縦スクロールバーが出る。横方向も活用して」。
- **(1)の事実**: 保存は編集のたびに行われ（400msの間引き。D23）、接続ボタンは間引き中の分を先に送るだけ。
  **それが画面から読み取れないのが問題**なので、ファイル名の横に状態を出す——何もしていないとき
  「設定は編集すると自動で保存されます」、編集直後「変更を保存します…」、送信後「保存しています…」、
  拡張ホストの`saved`で「自動保存しました」。`saved`の回数を`embedStore.savedRev`で数える。
  応答を待つ間に次の入力があれば「保存します」のまま（古い応答で保存済みと出さない）。
- **(2)の決定**: 欄を「接続先／サインオン／端末（プリンターは「プリンター装置」）／透かし」の束（`<fieldset>`）に分け、
  列に並べる。列の割り当ては`settingsLayout.ts`の1つの表——emulatorは3列（接続先+サインオン｜端末｜透かし）、
  printerは2列（接続先｜サインオン+装置）、spool/sql/ifsも2列（接続先｜サインオン。1列だと900×500で縦スクロールが出た）。
  **カードの幅も同じ表の列数から決める**（親が中身の幅に縮むので%が効かない。D22/D23）。並べる側とカード幅の側が
  別々に列数を持つと、片方だけ直したときにカードが列に合わなくなるので、表を1か所にした。
  狭い画面は`grid`の`auto-fit`で1列に折り返し、カード内でスクロールする。
  束の見出しがあるので、欄の名前は短くした（「透かし大きさ（px）」→「大きさ（px）」等）。透かしの色は選択と色見本を同じ行に置いた。
- **検証**: web-ui 2766 passed。mutation 5件すべてfail（応答で無条件に「保存しました」・`savedRev`を進めない・カード幅を
  列数から決めない・spool等を1列に戻す・送信時に「保存しています」にしない）。画面はChromiumで測った（test-result）。

## D25: アプリのマークを「5250 端末 クラシック」の配色にし、アイコンの生成経路を1本にする

- **背景**: 利用者の要望「ts5250のロゴのカラーリングを5250端末クラシックの配色に。favicon・Electron・VSCode拡張機能
  アイコン・ファイルアイコンなど漏れなく」。
- **決定**: `packages/web-ui/scripts/gen-icons.mjs`の地色・前景色を`styles.css`の`:root`（既定＝クラシック）の
  `--crt: #000000`・`--t-green: #00ff00`に変えた（以前は`#0f1a12`/`#3ddc7f`）。形は変えない。
- **出力の洗い出し**（`git ls-files`の画像と参照を全部見た）: `favicon.svg`・`favicon.ico`・`apple-touch-icon.png`
  （web・embed）、`electron/build/icon.png`（exe/dmg/AppImageと開発時のウィンドウ）、`electron/build/icon.ico`（Windows）、
  `vscode-extension/icon.png`（拡張のアイコンと`.ts5250`のファイルアイコンの両方が指す）。画面内にマークの複製は無く、
  `theme-color`やマニフェストも無い。
- **`icon.ico`だけ生成経路が別だった**——`electron/scripts/make-icon-ico.ps1`（pwsh・System.Drawing）で`icon.png`から
  焼いていた。pwshが無い環境（このコンテナ）では作り直せず、**色を変えても`icon.ico`だけ古い緑で残る**。
  `gen-icons.mjs`は既にICOを書けるので、16/24/32/48/64/128/256pxの`icon.ico`もここから出し、ps1は削除した
  （READMEの手順も`npm run gen:icons`に直した）。
- **作り直し忘れを落とす**: 生成のたびに`scripts/icons.stamp.json`（スクリプトと6出力のsha256）を書き、
  `test/app-icons.test.ts`が突き合わせる（定義だけ変えた／出力を手で差し替えた、の両方を落とす）。あわせてマークの色が
  `styles.css`のクラシックの2色と同じかを見る。**最初はテストの中で全サイズを描き直して比べたが、並列の全体実行で65秒かかり、
  CPUを奪って無関係のテスト4件をタイムアウトさせた**ので、描き直しは手で回す`--check`に残し、テストはハッシュの比較
  （39ms）にした。確かめたこと: 変更前のコミット済みファイルは、古い色の定義で`--check`すると`icon.ico`以外すべて
  バイト一致した（生成は決定的で、`icon.ico`だけ別経路だったことの裏付け）。

## D26: マークの字形を小文字の`ts`から大文字の`TS`にする

- **背景**: 利用者の要望「小文字のtsがベースのアイコンデザインを、大文字でTSベースにしてください」。
- **決定**: `gen-icons.mjs`の`SHAPES`を大文字に作り直した。色（D25）・下線・地の角丸は変えない。
  - `T`: 横棒（x 8〜30, y 11〜16）と縦棒（x 16.5〜21.5, y 11〜45）。
  - `S`: 小文字と同じく「接する2円の弧」で組む（矩形で組むと数字の5に見え、`TS5250`の中で「T5」と読み違える——小文字の試作で
    実際に起きた判断をそのまま引き継ぐ）。字高を`T`と揃えるため、字高34 = 4r + W から r = 7.25。
  - 2文字の外形の中心（x≈31.75）を下線の中心（x=32）に合わせ、左右の余白をほぼ揃えた（8 / 8.5）。
- **検証**: 全6出力を作り直し、`icons.stamp.json`と`test/app-icons.test.ts`で一致を確認。Chromiumで128/32/16pxを目視（16pxでも`TS`と読める）。
