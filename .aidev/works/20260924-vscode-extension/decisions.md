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
