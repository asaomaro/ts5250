# ホストサーバー（ACS データ転送相当）

2026-07-18 に signon 認証まで実装済み（`.aidev/works/20260718-acs-data-transfer`）。
その先の段階をここに積む。

## 前提となる調査結果

`.aidev/works/20260718-acs-data-transfer/research.md` に記録済み。要点:

- 移植元は JTOpen 本体(2364ファイル)ではなく **`archived/jtopenlite/`(321ファイル)** が本命
- signon は `0x7003`→`0x7004`、**database 等は `0x7001`→`0x7002`** と枠が違うだけで、
  パスワード置換値の生成と資格情報のバイト化は**完全に共通**（実装済みのものがそのまま使える）
- JTOpen は IBM Public License 1.0。**事実に基づく書き起こし**で進める（逐語移植しない）

## 段階

- [x] **SQL 実行（ダウンロード）** — database サーバー(8471/9471)への接続と SELECT
  - 移植対象は `DatabaseConnection.java` 相当の **約5,000〜7,000行のプロトコル層**のみ。
    `jdbc/`(14,880行) は JDBC API の皮なので TypeScript には不要
  - 公開する API は JDBC の作法ではなく素直な TS（`query(sql): Promise<Row[]>`）にする
  - **真の難所はバイト列の組み立てではなくデータ型変換**（パック/ゾーン10進数・日付時刻・
    可変長・DBCS混在・NULL指標マップ）。見積もりを厚めに見ること
  - 動機: `node-jt400` は JVM を起こすため起動が重い。MCP ツールとして短時間に叩く用途に合わない
  - **2026-07-18 完了**（`.aidev/works/20260718-hostserver-sql`）。実機で全型の取得を確認。
    実装で分かったこと: 実機は拡張形式ではなく**元形式**（列定義 CP 0x3805 / 結果 CP 0x3806）で返す。
    日付書式は接続時に ISO へ固定しないと**年が 2 桁**になり世紀が失われる
- [x] **アップロード** — 物理ファイルへの取り込み（`jtopenlite/ddm/` 相当のレコードレベルアクセス）
  - **2026-07-19 完了（追記のみ）**（`.aidev/works/20260719-hostserver-upload-ddm`）。
    実機で書いて **SQL で読み返して**一致を確認（負数・小数・ゼロ・空文字・NULL）
  - 分かったこと: **DDM は他のホストサーバーと握手が違う**（EXCSAT → ACCSEC → SECCHK・
    ポート 446）ので `startHostServer()` は使えない。ただし**資格情報のバイト化と
    パスワード置換値は共通**（原典が `// Copied from HostServerConnection.` と明記）
  - **`DDMField`（1,220 行）を移植していない**——列レイアウトは `QSYS2.SYSCOLUMNS` から
    計算する方式にした。実機で `recordLength` がホストの申告と一致することを確認済み
  - 積み残し: **バッチ書き込み**（現状 1 件ずつ・ブロッキング係数 1）／
    読み取り・キー付き・更新・削除（SQL があるので動機が弱い）／
    `VARCHAR`・日付時刻・DBCS 列（対応外として明示的に失敗させている）
- [x] MCP ツールとして公開
    → 20260719-hostserver-mcp-tools（PR #93）で公開。`packages/server/src/host-server-tools.ts` に
      `host_sql` / `host_command` / `host_call_program` / `host_list_spools` / `host_get_spool` /
      `host_read_file` / `host_write_file`。
      その後に足したものは出典が別: アップロードの `host_upload_table` は
      20260720-csv-upload-ui（PR #104）、`host_dtaq_*` は 20260720-dtaq-server（PR #108）
- [x] Web UI から操作（テーブル選択 → CSV ダウンロード、CSV をドロップしてアップロード）
    → ダウンロードは 20260719-hostserver-web-ui（PR #94）、アップロードは
      20260720-csv-upload-ui（PR #104）で完了。入口は
      `packages/web-ui/src/components/TransferPane.vue`（「データ転送（表 ⇄ CSV）。ACS の Data Transfer に相当」）
  - **ダウンロード側は 2026-07-19 完了**（`20260719-hostserver-web-ui`。SQL ペイン＋CSV）。
    ~~**アップロード側は未着手**——DDM の土台ができたので着手可能になった~~（PR #104 で完了）
  - 落とし穴（実機で確認）: **CL 経由の RUNSQL では `DECIMAL(5,0)` が通らず、
    `DECIMAL(5, 0)`（カンマの後に空白）なら通る**。`CHAR(10)` は通るので括弧自体は問題なく、
    括弧内のカンマ直後に数字が続く形が CL の解釈で壊れる

## 積み残し（signon 段階から）

- [x] DES 経路（QPWDLVL < 2）の対応
    → 2026-07-21 完了（PR #109 `feature/password-level-0-des-auth`）。
      `packages/core/src/hostserver/des.ts`（**167 行**。FIPS 46-3 の標準テーブル。Web Crypto に
      DES が無いため自前実装）＋ `password.ts` の `passwordSubstituteDes`。
      `signon.ts:222-229` と `server-connect.ts:156` が `passwordLevel < MIN_SHA_PASSWORD_LEVEL` で分岐する。
      jtopenlite `encryptPasswordDES` との差分テストで **805/805 バイト一致**
      （FIPS 既知解ベクタは `des.test.ts`、代表ベクタは `hostserver-password.test.ts`）
  - ~~PUB400 はレベル3のため未実装。手書きDES 700行超が必要で、現状は明示的に
    `HOST_SERVER_UNSUPPORTED` で失敗する。**レベル0/1 の実機に当たってから**でよい~~
    **← 3 点とも現状と違う**（実装済み／700 行超ではなく 167 行／`assertPasswordLevelSupported` は撤去済み）
  - DDM(DRDA) の SECCHK は SHA 前提のままなので、レベル 0/1 では明示的に断る（`ddm-connection.ts`）
- [x] パスワードレベル 0/1 の**実機**での認証成功の確認
  - PR #109 の本文が自ら挙げた穴——「この環境から到達できないため未検証」。
    参照実装とバイト単位で一致しているので確度は高いが、実機のハンドシェイクは通していない
  - 検証手順: `AS400_USER=xxx AS400_PASSWORD=yyy npm run cmd -w @as400web/hostserver-check -- --host <実機> [--tls]`
    → `20260801-realhost-version-and-pwdlevel`（PR #244）で**通した**。
      社内機 **SR-OSAKA は `password level : 0`**（`tools/hostserver-check/dist/main.js` の
      サインオンで `認証成功`）。上の検証手順そのもの（コマンドサーバー経由）でも
      読み取り専用の `CHKOBJ OBJ(QSYS/QCMD) OBJTYPE(*PGM)` が `成功 rc=0x0`。
      **DES 経路（`signon.ts:222-229` の `passwordLevel < MIN_SHA_PASSWORD_LEVEL` 分岐）が
      実機のハンドシェイクを通った**（平文接続。TLS は未確認）
    - レベル **1** は未確認（当たれる機械が無い）。0 と 1 は同じ DES 経路なので確度は高い
    - DDM(DRDA) の SECCHK は SHA 前提のままなので、レベル 0 の SR-OSAKA では**断られる**はず
      （`ddm-connection.ts`）。**実測していない**——CSV 取り込み等の DDM 経路を
      SR-OSAKA で使うなら先に確かめること
- [x] 誤パスワード時の戻りコードを実機で確認
  - **2026-07-18 完了**。1 回の失敗では無効化されないとの情報を得て実施。`0x0003000B` を確認した。
    副次的な発見: **存在しないユーザー ID でも `0x0003000B` が返る**（ユーザー列挙対策と思われる）

## コマンドサーバー経由の機能（2026-07-18 追記）

JTOpen の `archived/jtopenlite/` を再調査して洗い出した。いずれも**今回作った認証基盤の上に載る**
（database と同じく `0x7001`→`0x7002` の枠を使うだけで、パスワード置換値と資格情報のバイト化は共通）。

規模の実測:

```
command/      92ファイル 11,219行  リモートコマンド＋プログラム呼び出し
components/   24ファイル  3,189行  高水準API（List* 系。command の上に載る）
ddm/          15ファイル  4,361行  レコードレベルアクセス
file/          4ファイル  1,221行  IFS
```

- [x] **コマンド実行 / プログラム呼び出し**（`command/CommandConnection` + `command/program/`）
  - **下記 List* 系すべての土台**。これ無しに他は作れないので最初に着手する
  - 現在の MCP `run_steps` 等は 5250 の画面操作だが、こちらは**構造化された応答**が返り、
    画面レイアウトの変化に壊されない
  - **2026-07-18 完了**（`.aidev/works/20260718-hostserver-command`）。
    レビューで、応答が宣言する template 長を見ずに 16 決め打ちで読んでいた箇所を修正した
    （signon の D4 と**同じ種類の間違い**の再発。実機は 16 を返すので動いてはいた）
- [x] **スプールの一覧・取得**（`components/ListSpooledFiles` / `SpooledFileInfo`）
  - needs: コマンド実行
  - **現状との違いが重要**: 今の `PrinterSession` は AS/400 が仮想プリンターに SCS を送ってくる
    **push 型**で、(1) プリンターセッションを開いておく必要があり (2) そのデバイスに出力を
    向ける必要があり (3) **過去に出たスプールは取れない**
  - こちらは既存スプールを任意の OUTQ から検索・取得できる **pull 型**。
    「過去のスプールを後から PDF 化する」が可能になる
  - 既存実装を置き換えるのではなく、**別の入り口として補完する**関係
  - **2026-07-18 完了**（`.aidev/works/20260718-hostserver-spool`）。
    実装で分かったこと: スプール CCSID は接続オプションで指定できるようにした
    （当初 273 決め打ちで、日本語環境 930/939/5035 では化ける）
- [x] **MSGW の検出**（`components/ListQSYSOPRMessages` / `ListJobLogMessages`）
  - needs: コマンド実行
  - **要実機確認（期待しすぎないこと）**: 以前 PUB400 で調査した際、MSGW への*応答*は
    権限の壁で不可能と確定している（ユーザー MARO は特殊権限 `*NONE`、`*JOBCTL`/`*SPLCTL` なし、
    OUTQ `QUSRSYS/PRT_MARO` は QTCP 所有で `AUTCHK(*OWNER)`）
  - ただし**メッセージの検出だけ**なら権限が足りる可能性がある。「今 MSGW で止まっている」と
    気づけるだけでも実用価値は大きい
  - この領域は過去に推論で 2 回外している。**実機で確かめるまで可否を断定しない**
  - **2026-07-18 完了（ただし検証は不完全）**（`.aidev/works/20260718-hostserver-msgw`）。
    `retrieveMessage` / `answerMessage` まで実装したが、**PUB400 で MSGW を意図的に作れず、
    MSGW が実在する状態での往復は未検証のまま**（下の積み残しに再掲）。
    収穫: 自分が所有する OUTQ を作れば `CPF3464` は回避できる。ただし writer が常駐せず
    スプールは `READY` のままで、MSGW を誘発できなかった
- [x] **IFS ファイルの読み書き**（`file/`）
  - needs: コマンド実行（またはファイルサーバー 8473 への直接接続）
  - 4ファイル1,221行と小さく費用対効果が高い。PDF/CSV を IBM i 側に置く・取る用途
  - アップロード機能（DDM）と相性が良い
  - **2026-07-18 完了**（`.aidev/works/20260718-hostserver-ifs`）。
    実装で分かったこと: 応答のデータ開始位置は**宣言されたテンプレート長から求められない**。
    「決め打ちを整理する」修正を試みたが実機で往復が壊れ、固定配置に差し戻した
    （＝**推測で直さない**の実例）。ディレクトリ操作と複数ブロック読み書きは未対応
- [x] ジョブ / オブジェクト / ユーザーの一覧（`components/ListActiveJobs` / `ListObjects` / `ListUsers`）
  - needs: コマンド実行
  - あると便利だが動機が弱い。優先度低
  - **2026-07-18 完了**（`.aidev/works/20260718-hostserver-lists`）。実機でジョブ 30 件 /
    オブジェクト 20 件 / ユーザー 4 件を確認。ジョブ一覧は一度「0 件しか返らない」として
    見送りかけたが、**出力パラメータの位置の読み違い（リスト情報は index 5、3 ではない）**が原因だった

### 着手順の目安

**2026-07-18 に下記はすべて完了した**（記録は各項目に追記済み）。残りは冒頭「段階」の
アップロード / MCP 公開 / Web UI と、下の積み残し。

```
SQL（既定路線・本命）                       ✅
  └ コマンド実行 ─┬─ スプール一覧・取得   ✅  ← この PJ の中心用途に直結
                 ├─ MSGW 検出            ✅（実装のみ。MSGW 実在時は未検証）
                 ├─ IFS                  ✅
                 └─ ジョブ/オブジェクト/ユーザー一覧 ✅
```

## SQL 実装からの積み残し（2026-07-18 追記）

`20260718-hostserver-sql` の test / review / retro で挙がったもの。

- [x] **database 接続にフレームトレースを入れる**（signon にはある `traceFrame` 相当）
  - 資格情報の漏洩リスクは無い（そもそも出力しない）が、**障害時の診断手段が無い**。
    実装中は使い捨てスクリプトを何度も書く羽目になった。実利のある不足
  - パスワード置換値（CP 0x1105）のマスクは signon と同じ扱いにする
  - **2026-07-19 完了**（`.aidev/works/20260719-db-frame-trace`）。
    実測すると**穴は database だけでなく 4 接続すべて**だったので、共通ヘルパにして
    signon / server-connect / db / command / netprint / IFS の 6 箇所に適用した
  - **この項目の記述が見落としていたこと**: マスクだけでは足りない。
    **SQL の応答フレームには取得した業務データそのものが載る**ので、
    `LOG_LEVEL=debug` は照会結果を平文で stderr に出す。値を 64 バイトで切り、
    README に明記した（伏せると切り分けに使えないため本文は伏せない）
  - 積み残し: **DDM のトレース**（フレーム形式が違い別実装が要る）／
    **CP `0x111A` の正体を特定する**（signon 応答の 20 バイト。原典も解析しておらず
    不明なため、安全側に倒して伏せている）／大量フレーム時のログ量の実測
- [x] **拡張形式の応答（列定義 CP 0x3812 / 結果 CP 0x380E）の解析**
  - ~~実機（IBM i 7.5）が元形式でしか返さなかったため未実装~~
    **← この記述は誤りだった（2026-07-20 に判明）**
  - 実機の制約ではなく、**こちらが `useExtendedFormats`（CP 0x3821）を送っていなかった**だけ。
    同じ実機・同じバージョンで、要求すれば超拡張形式（0x3812 / 0x380E）が返る
  - **2026-07-20 完了**（`.aidev/works/20260720-sql-extended-format`）。
    これにより **LOB 列を含む結果セットが扱えるようになった**——元形式のままだと
    ホストが prepare で `rcClass=7, code=-101` を返し、`SELECT *` が通らなかった
  - **落とし穴**: `lobFieldThreshold`（CP 0x3822）を原典どおり 15,728,640 にすると、
    しきい値以下の LOB が**インラインで丸ごと返る**。DBCLOB(2M) の表を 2 行取っただけで
    応答が **8.4MB**（0 なら 10KB）。**0 固定にしてオプションにもしていない**
  - 積み残し: ロケーター経由の LOB 本体取得（`retrieveLOBData`）／
    0xF2 を受け付けない古いホスト向けの 0xF1 分岐／圧縮された結果データ
- [x] **逐次取得（`stream`）をブロッキング係数を跨ぐ規模で検証**
  - 既定 100 行。100 行超の結果セットで複数回 fetch が正しく回るかは未検証
  - **2026-07-19 に `query` 側を確認**（250 行で 100 行境界を 3 回跨ぐ）。
  - **2026-07-20 に `stream` も実証**（`20260720-sql-paging`）。
    画面のページングで **1,250 件・25 ページ・重複ゼロ**。100 行境界を 12 回跨いだ
  - **2026-07-30 に早期打ち切りも実測**（`20260730-sql-fetch-limit` research F1。
    再現は `scripts/research-sql-cancel-osaka.mjs`）:
    上限 1 / 50 / 99 / 100 / 101 / 200 / 250 の**すべて**で、打ち切った直後に
    同じ接続で SELECT が通る。10 回続けても壊れず、直後に UPDATE（非クエリ経路）も通る。
    **カーソルの途中終了はホストに副作用を残さない**
  - 併せて**潜在バグを 1 つ潰した**: `openQuery` が prepare で失敗したとき占有を解いておらず、
    SQL の誤り 1 回でその接続が二度と使えなくなっていた（以降すべて
    「another query is in progress」）。単発接続では隠れていた
- [x] PUB400 以外の IBM i での検証
    → 社内機 **SR-OSAKA**（~~IBM i 7.5~~ **7.3**）で SQL を実測済み。20260730-sql-non-query-statements（PR #218）と
      20260730-sql-fetch-limit（PR #219）。後者は 20,000 行 × `CHAR(50)` の全件取得で
      201 往復 / 1,191,336 バイト / 2,072ms
- [x] IBM i 7.5 **以外のバージョン**での検証
  - ~~PUB400 も SR-OSAKA も 7.5。**バージョン差による違いには当たっていない**~~
    **← 前提が誤りだった。** `20260801-realhost-version-and-pwdlevel`（PR #244）で実測:
    **SR-OSAKA は IBM i 7.3**（`V7R3M0` ＋ 累積 PTF `SF99730` / `CUMULATIVE PTF PACKAGE C9116730`
    ＝末尾 3 桁が版数）。PUB400 が 7.5（`V7R5M0`。`20260718-hostserver-command/test-result.md:19`）。
    つまり **2026-07-26 以降の SR-OSAKA での実測はすべて 7.3 上**で、
    **気づかないうちに 7.3 と 7.5 の 2 リリースを跨いで検証していた**
  - **⚠ 過去の記録は「SR-OSAKA・IBM i 7.5」と書いている**（`.aidev/works/*` に 15 件超）。
    その時点の記録なので書き換えていない。**7.3 で測った結果として読むこと**。
    実機の一覧と確かめ方は `scripts/README.md`「検証に使う実機」
- [x] **7.3 と 7.5 で挙動が違う箇所を洗う**（上の項目から分割）
  - 「2 リリースで動いた」ことと「差分を把握している」ことは別。**どちらか一方でしか
    測っていない項目**（DDM / DTAQ / スプール / MSGW など）は、片側だけの確認になっている
  - 版数の確認は**表示 1 つを信じない**（`scripts/README.md` の 2 経路）。
    「SR-OSAKA も 7.5」はおそらく誰も測らずに書かれて広まった
  - → `20260822-host-release-diff`（PR #349）で両機を同じ手順で叩いて並べた
    （`scripts/compare-hosts-osaka-pub400.mjs`。再実行できる）。
    **当方の機能で挙動が割れたものは無い**——SQL・CL・IFS・スプール・DTAQ は全て一致。
  - **版数由来の差は QSYS2 のサービス数（230 → 286）だけ**で、**当方には当たらない**。
    参照している 10 個を両機で照会して**全て 7.3 にも在る**ことを確かめた
    （`QSYS2.QQQ3000` は注釈の中だけでコードは使っていない）
  - 他の差（QCCSID / QCHRID / QPWDLVL / QMAXSIGN / QAUTOVRT / QLANGID、PTF が引けない）は
    **すべて構成・権限の差**。版数の差として読まないこと
  - **副産物**: pub400 で `CRTLIB` の定義だけ引けない件は `CPF9802 権限なし` で、
    こちらが `result.messages` を捨てて `returned no data` と言っていた。
    ホストの文言を返すよう直した（CPF → コードの写しは `cpf-errors.ts` に共有）

## コマンドサーバー実装からの積み残し（2026-07-19 追記）

- [x] **MSGW が実在する状態での `retrieveMessage` / `answerMessage` の検証**
  - `20260718-hostserver-msgw` の最大の穴。PUB400 では MSGW を誘発できなかった
  - ~~`answerMessage` の応答文字列だけ**可変長で送っている**……MSGREPLY が固定長を要求するなら
    隣の値を巻き込む恐れがある~~
    → `20260801-msgw-realhost-verify`（PR #247）で実機 SR-OSAKA に MSGW を作って検証。
      **NUL 終端の応答はそのまま受理された**（`answerMessage(msg, "I")` が成功し、
      MSGW が解けて印刷まで届いた）。**実装は正しかった**
    - `retrieveMessage` は `CPA3394` と**24 バイトのハンドル**を返す
    - 誘発の手順: 既存の仮想プリンター装置を `VRYCFG *ON` →
      `PrinterSession.connect`（ホストがライターを起動）→ `CHGJOB OUTQ(...)` →
      **`OVRPRTF FILE(QPRTLIBL) FORMTYPE(...)`**（`DSPLIBL OUTPUT(*PRINT)` が作るのは
      `QPRTLIBL`。ここを間違えると MSGW にならず素通りする）→ `DSPLIBL OUTPUT(*PRINT)`
    - **SR-OSAKA はプリンターの自動構成を許さない**（`8940`）。`CRTDEVPRT DEVCLS(*VRT)` で
      自作しても `VRYCFG` が `CPF2640`、セッションは `8903`。**既存装置を借りるしかない**
    - 一覧の状態名は **`MESSAGE_WAIT`**（画面表記の `MSGW` ではない）
    - 再現: `scripts/research-msgw-osaka.mjs`
  - **応答文字列が長い場合は未検証**（試したのは `"I"` の 1 文字）。
    当初の懸念「固定長を要求するなら隣を巻き込む」は**1 文字では起きない**ことしか示せていない
- [x] **メッセージ本文が CCSID 37 決め打ちで化けていた**（上の検証で発見・PR #247 で修正）
  - `decodeNpString` が 37 固定で、サーバー CCSID 5035 の日本語が読めていなかった。
    サインオンが申告する `serverCcsid` を使うようにした
  - **ID は英数字なのでどの CCSID でも読める**——だから「メッセージが無い」経路の確認や
    ID の比較テストでは**一度も表面化しなかった**。本文を実際に読んで初めて分かる
  - `errorFromReply`（CPF メッセージの組み立て）は**37 のまま**にした。
    この work で確かめていない経路を巻き込んで変えないため。**要確認**
- [x] IFS のディレクトリ操作と、`DEFAULT_CHUNK` を超える複数ブロック読み書きの検証
    → 20260720-ifs-file-browser で消化。複数ブロックは 4MB まで実機で SHA-256 一致、
      ディレクトリ操作は listFiles(一覧)/mkdir(作成) を実装・実機検証（rmdir は下記に残す）

## IFS ファイルブラウザからの積み残し（2026-07-21 追記）

20260720-ifs-file-browser で Web UI から IFS を扱えるようにした際、
spec に含むが今回は実装しなかったもの。各 work の decisions に理由あり。

- [x] IFS テキストの CCSID 決定表（中身推定 → タグ → 手動切替）と `ccsid`/`detectedBy` 応答
    → 20260723-ifs-ccsid-decode で実装。File Server の**ハンドル指定 ListAttrs（OA2）**でタグを取り、
      決定表（手動 → BOM → UTF-8 → タグ）で復号。保存も読んだ文字コード・行末（0x15）・BOM のまま戻す。
      実機（PUB400）で EBCDIC 1399 / 273 / 37 の表示・編集・保存の往復を確認済み
- [x] IFS の書き込みで `dataCcsid` を明示し、新規作成ファイルのタグを中身と合わせる
    → 現状は 0（サーバー既定）で開くため、UTF-8 を書いても ~~**850 のタグ**~~ が付く（20260720 research F3）。
      読む側は決定表①（中身推定）で救えているが、他ツールから見ると嘘のタグのまま。
      `IfsConnection.writeFile` の `dataCcsid` は既に受け口だけある（20260723 decisions D5）
    → `20260801-ifs-write-dataccsid`（PR #249）で対応。`/api/host/ifs/write` のテキスト経路が
      **符号化に使った CCSID をそのままタグにする**（`host-ifs.ts`）。
      実機で `1208` / `1399` とも**採用されることを確認**（受け口があるだけで未実測だった）
    - **既定タグは機械ごとに違う**。~~850~~ → SR-OSAKA は **1041** / PUB400 は **850**。
      ジョブ・システムの既定に依る
    - **既存ファイルのタグは上書きでも変わらない**（実機で確認）。
      よって効果は**新規作成に限られる**が、**他人のファイルを勝手に付け替えない**という
      望ましい性質なので回避しない
    - バイナリ（base64）とアップロード経路は**触っていない**（文字コードの概念が無い）。
      65535 でタグ付けするかは別の判断
    - 再現: `scripts/research-ifs-dataccsid-osaka.mjs`
- [x] CCSID 850 / 437 のテキスト表
    → Node の TextDecoder に無く、実機の 850 タグは中身が UTF-8/ASCII で決定表①が拾うため今は不要。
      要るときは `tools/gen-tables` に `ibm-850_P100-1999.ucm` を足す（ICU に存在することは確認済み）
    → `20260822-hostserver-sql-and-ccsid`（PR #351）で**同梱の表を入れた**（`ebcdic/src/oem-tables.ts`）。
      `.ucm` は取りに行かず、**2 つの独立した実装から起こして全 256 バイトが一致することを確かめた**
      （CPython の `codecs`＝Unicode Consortium の対応表由来 と `iconv-lite`）。片方だけだと写し違いに気づけない。
      0x00–0x7f は ASCII と同一なので上位 128 だけ持つ。**単バイトなので符号化もできる**（逆引き）。
      ⚠ **決定表の順は変えていない**——中身の推定が先で、この表が効くのは推定が外れたときだけ。
      手動選択の候補にも出す
- [x] IFS プレビューのサイズ上限（5MB）とヌルバイト判定（03 D11）
    → server の readMaxBytes が最後の砦。クライアント側で先回りすると体感が良くなる
    → 20260801-ifs-limits-and-race で実装。**先回りには上限を先に知る必要がある**ため
      `GET /api/host/ifs/limits`（接続不要）を新設し、`usePreview` が
      `sizeHint > readMaxBytes` のとき**読みに行かずに断る**ようにした
      （`usePreview.ts` の `tooLarge`）。断るのは「サイズが分かっていて、上限も分かっていて、
      超えている」ときだけ——どちらかが不明なまま断ると読めるファイルを見せられなくなる。
      境界（同値）はサーバーと同じ `>` で揃えた
    - **ヌルバイトは復号後の文字列で見る**（追加往復なし）。`content` に `U+0000` があれば
      `binaryContent` を立て、`undecodable`（文字コード未対応）とは別の案内にする——
      取り違えると利用者が当たらない文字コードを選び直し続ける
- [x] IFS のディレクトリ削除（rmdir = 0x000E, CP 0x0001）
    → 20260723-ifs-pane-nav-file-ops で実装。**テンプレート長は 10**（ファイル削除の 8 とは
      フラグ 2 バイト分違う）。中身ごとの再帰削除・リネーム（0x000F）・一覧の「上位フォルダへ」も同時に入れた
- [x] IFS の zip 上限「値」を UI に表示（現状は超過した実測値のみ）
    → 20260801-ifs-limits-and-race で実装。**サーバーは既に `maxFiles`/`maxBytes` を
      送っていた**（`host-ifs.ts` の zip・read の 413）ので、使っていなかった `messageFor` を直した。
      上限を送っていなかった `TOO_MANY_DIRECTORIES` にだけサーバー側を追加。
      削除の `TOO_MANY` が既に `上限 N 件` を出しており、同じ関数の中で扱いが不揃いだった
    - `TOO_LARGE` は**複数系（zip）と単数系（1 ファイルの読み取り）で文面を分けた**——
      1 本のファイルに「対象を絞るか、個別に取得してください」は当たらない
    - 上限が載っていない応答では**上限の断片ごと省く**（`undefined` を出さない）
- [x] CLI 引数 `--ifs-zip-max-bytes`/`-files`/`-dirs`/`--ifs-read-max-bytes`/
      `--ifs-delete-max-entries`/`--ifs-delete-max-dirs` を README に追記
    → PR #199（`docs: README / AGENTS の抜け漏れ・矛盾をコードと突き合わせて直す`）で記載。
      `README.md:162-164` に既定値つきの表がある（読み取り 5 MiB / zip 20 MiB・500・5000 /
      再帰削除 1000・500）
- [x] IFS プレビューの競合対策（速い応答が勝つ。世代トークンで塞ぐ。03 review S3）
    → 20260801-ifs-limits-and-race で実装。`usePreview` に単調増加のトークンを持たせ、
      `await` 明けに `isStale()` で門番する
    - **守るべき代入は 4 か所**（テキストの state / blob の state / `catch` の error /
      `finally` の loading）。1 つでも漏れると症状が残るので、テストも 4 本に分けた
    - **blob は URL を作る前に捨てる**——`revoke()` は `state.value?.url` しか見ないので、
      作ってから捨てると解放する当てが無くなる（作らなければ漏れようがない）
    - `reload` の巻き戻し（失敗時に直前の表示へ戻す）も同じトークンで守る
    - **`AbortController` は採らなかった**: `ifsApi.post()` に `signal` を通す配管が全 API に要り、
      かつ**サーバーは既にホストから読み切っている**ので節約できるのはブラウザ側の受信だけ。
      中断は `AbortError` を投げるので門番が 2 種類になる。「応答は待つが、使わない」に徹した
    - 落とし穴（この作業で踏んだ）: **早期 return する分岐（`binary`/`tooLarge`）でも
      `loading` を落とさないと `true` に張り付く**。先行する遅い要求の `finally` が
      門番で握られ、誰も落とさなくなる（review ラウンド 1 の must）

## SQL の複数文実行からの積み残し（2026-07-23 追記）

- [x] 結果を返さない文（INSERT / UPDATE / DELETE / CREATE 等）を SQL 画面から実行する
    → 20260730-sql-non-query-statements で実装。**`executeImmediate` は要らなかった**——
      `prepareAndDescribe`(0x1803) → `execute`(0x1805) を**マーカーデータ無し**で送れば
      DML も DDL も通る（SR-OSAKA で実測。`scripts/research-sql-exec-osaka.mjs` で再現できる）。
      マーカーが無い文ではマーカー形式が**空（0 バイト）で返る**ので `changeDescriptor` は省ける。
      上の見立て（拡張形式の文テキストか RPB の設定が鍵）は**別の道を指していた**
    - 成否は **SQLCODE の符号**で見る。`0` 成功 / **正は警告つき成功**（実ライブラリーへの
      `CREATE TABLE` は `7905 / 01567`。捨てると「作られたのに何も言われない」）/ 負は失敗
    - 影響行数は SQLCA の `updateCount`。**DDL も 0 で返る**ので「DDL の完了」と
      「0 行に影響した DML」は件数から区別できない → 文の先頭語で決める（`isRowCountStatement`）
    - SELECT を非クエリ経路に流すと `-518 / 07003` で**明確に落ちる**（黙って壊れない）
- [x] `executeImmediate`(0x1806) / `prepare`(0x1800) が `-215` で拒まれる理由
    → **前提が誤りだった。** `20260822-hostserver-sql-and-ccsid`（PR #351）で実機に撃ち直したところ、
      **拒否していたのはホストではなくこちらの組み立て**——パラメータ値の
      **CCSID(2)＋長さ(2) の前置きを付けていなかった**ため `PWS0011 文字変換中にエラーが起こった`
      が返っていた。前置きを付けたら `executeImmediate` も `prepare` も通る
    → **1 往復に切り替えた**（マーカーの無い非クエリ文）。2 実機で両方の道を突き合わせ、
      DML・DDL とも `rcClass` / `SQLCODE` / 影響行数が一致することを確認。
      pub400（インターネット越し）で 1 文あたり **約 285ms → 従来 566ms** と半減する
    → ⚠ **クエリだけは載せない**——`SELECT` を `executeImmediate` に渡すと
      `rcClass=0 / SQLCODE 0` で**黙って通る**（行は返らない）。2 往復の道は `-518 / 07003` で断る
    → ⚠ **経路を比べるときは 2 往復の道も `execute` まで走らせること**。`prepareAndDescribe`
      だけで止めて比べ、`CREATE PROCEDURE` が「1 往復だけ失敗する」と誤読した
      （実際は QTEMP に routine を作れないだけで両方 `-457`）
- [x] マーカー（`?`）付きの非クエリ文を実行する
    → `20260822-hostserver-sql-and-ccsid`（PR #351）で `ExecuteOptions.parameters` を追加。
      値を渡したときだけ `?` を通す（`changeDescriptor` → `execute`。`marker-encode.ts` を再利用）。
      **既定は今までどおり断る**——値を埋めた文で足りる場面が多いので安全側に置く。
      **引用符や日本語が混ざる値を自分で埋め込むのは危うい**ので、そこはこの引数で渡す
    → 数が合わなければ**ホストへ行く前に断る**。`?` が無いのに値を渡した場合も断る（黙って捨てない）。
      実機 2 機で `INSERT` / `UPDATE` / `DELETE`・`O'Brien "x"`・NULL を確認。
      pub400（CCSID 273）では日本語が `CCSID 273 では書けない文字が含まれます` で断られる（化けない）
- [ ] MCP の `host_sql` から非クエリ文を実行させるか決める
    → 画面（`/api/host/sql`）は 2026-07-30 から実行できるが、**MCP は SELECT 専用のまま**
      （`host_sql` は `query` を呼ぶ。更新は `host_command` の `RUNSQL` で足りている）。
      AI から取り消せない書き込みを撃たせるかは**方針の判断**なので、勝手には広げていない
- [x] SQL 結果表の行を仮想化する（表示範囲だけ描く）
    → 1 タブぶんの初回描画（200 行 × 40 列 ＝ 8,000 セル）が今も 100ms 前後かかる。
      `pageSize` を 1000 にすると 40,000 セルになる。
      **`table-layout: auto` のままだと描画範囲で列幅が揺れる**ので、幅の決め方とセットで設計が要る
      （20260723-sql-multi-statement の decisions D1）
    → `20260802-sql-table-virtualize`（PR #291）で対応。実ブラウザ＋実機で実測:
      **200 行 123ms → 88ms / 1000 行 582ms → 112ms**（DOM に載る行は 33）
  - **律速はレイアウトではなくセル生成だった。** 列を減らして測ると 1 セルあたり
    ~14µs でほぼ一定（1000 行 × 8 列 = 117ms / × 40 列 = 547ms）。
    つまり **`table-layout: fixed` にするだけでは速くならず**、
    **セルを作らない**ことだけが効く。**測らずに始めると幅を直して満足しかねない**
  - 幅は**全行の文字数から計算して宣言**する（標本にしない——先頭 N 行で決めると
    後ろの長い値で列が足りなくなる）。表示と幅計算は `cellText` 1 本を共有する
  - ⚠ **全角は半角の 2 倍ではない**（実測 **1.625 倍**）。`IBM Plex Mono` は CJK の
    字形を持たず**代替フォントが描く**。2 で数えると日本語の列だけ 2 割広くなる。
    `displayWidth` に重みを渡し、実測した比を使う
  - ⚠ **「まだ測っていない」と「測れない」を分ける。** ビューポート高は描いた後でないと
    測れないので、0 を「測れない＝全行描く」に倒すと**1 枚目で全行を描いてから間引く**
    ことになり、**仮想化前より遅くなった**（1000 行で 582 → 876ms）
  - ⚠ **`npm run build`（root）では web-ui の `dist` が作られない**（`tsc -b` ＋ 型検査だけ）。
    実ブラウザで測るなら `npm run build -w @as400web/web-ui`。
    忘れると**古いバンドルを測って「効いていない」と出る**（実際に 1 度踏んだ）
  - **意図した変更**: 列幅に上限 120 文字（1 セルの長大な CLOB で画面が埋まるのを防ぐ）。
    選択・コピーが画面外の行に及ばなくなる（仮想化の代償。CSV は別経路なので無事）
  - 基準線: `scripts/research-sql-table-render-osaka.mjs` /
    確認: `scripts/verify-sql-table-virtualize-osaka.mjs`（16/16）

## MCP 公開からの積み残し（2026-07-19 追記）

`20260719-hostserver-mcp-tools` の test / review で挙がったもの。

- [x] **`host_sql` の取得量を制御できるようにする**
  - 現状 `maxRows` は**応答に載せる行数の上限であって、ホストから取得する行数の上限ではない**。
    `query` が結果セットを全件取得してから返すため、大きな表では全行がメモリに載る
  - **2026-07-30 に解消**（`20260730-sql-fetch-limit`）。`queryLimited()` を足し、
    `host_sql`（MCP）と `/api/host/sql` の単発経路を載せ替えた。
    **上限＋1 行で結果セットを打ち切る**（+1 は「続きがあるか」を測るため
    ——`rows.length === limit` で推測すると**上限ちょうどのときに嘘になる**）
  - SR-OSAKA で実測（20,000 行 × `CHAR(50)`）: 全件 **201 往復 / 1,191,336 バイト / 2,072ms**
    → 上限 200 で **3 往復 / 約 12KB / 44ms**。MCP 経路は接続込み 177ms
    （`scripts/verify-sql-limit-osaka.mjs`）
  - **ブロッキング係数も残りに合わせる**——既定 100 のままだと上限 1 でも 100 行ぶん届く
    （実測 2,956 → 184 バイト）。上限が既定を超えるときは既定のまま刻む
    （1 往復の応答を膨らませない）
- [ ] 画面のページング経路も上限つき取得に寄せるか決める
    → 今回は**触っていない**（`pageSize` 指定は結果セットを保持して続きを読む別の要求）。
      ただし「1 ページだけ見て閉じる」使い方が多いなら、保持せず打ち切る方が接続を掴まない。
      使われ方を見てから決める
- [x] **LAN 内 IBM i での接続所要時間の実測**
  - PUB400（インターネット越し・TLS）では **4〜7 秒/呼び出し**で、処理量に比例せず
    接続確立が支配的だった。LAN なら大幅に短いと**見込まれる**が未検証
  - 実測して許容できないと分かった場合にのみ、接続プールを検討する（先に複雑さを払わない）
    → 20260730-sql-fetch-limit（PR #219）で社内機 **SR-OSAKA** を実測。
      **MCP 経路が接続込み 177ms**（REST 単発は 117ms）。PUB400 の 4〜7 秒に対し 25〜40 倍速い。
      **接続確立は支配的ではなく、接続プールは要らない**（複雑さを払わずに済んだ）
- [x] `host_call_program` を正しいパラメータ列で成功させる検証
  - 実機確認は `MCH0802`（パラメータ数不一致）までで、**呼び出し経路が通ることしか確かめていない**
    （`20260719-hostserver-mcp-tools/test-result.md:49`。`QGYOLSPL` にパラメータ 0 個で呼んだ）
    → `20260801-call-program-realhost`（PR #250）で通した。**実装は正しく、コード変更は不要**だった
      ——足りなかったのは成功例だけ。`packages/` は 1 行も変えていない
    - `QUSROBJD`（`OBJD0100`）で `QSYS/QCMD (*PGM)` を引き、**名前・ライブラリ・種別が
      期待どおり**返ることを確認（`bytesReturned=90`）。
      `QSYRUSRI`（`USRI0100`）でも**ユーザー名**が読める——**書式の違う API を 2 つ**通した
      （1 つだと偶然オフセットが合っている可能性を排除できない）
    - **出力の位置合わせも裏づいた**: `outputs = [<100B>, null, null, null, null, null]`。
      MCP ツールの説明「出力パラメータは要求した順で返る前提」は正しい
    - パラメータの作り方: 文字列は **EBCDIC・右空白詰めの固定長**、長さは 4 バイトの
      ビッグエンディアン、**エラーコード構造の先頭 4 バイトは 0**（＝例外で知らせる。
      非 0 にするとエラーが構造体に入って**メッセージが出なくなり失敗を見逃す**）
    - 再現: `scripts/research-call-program-osaka.mjs`（副作用なし）
  - **未確認**: `inout` / `null` のパラメータ種別、受け取り変数が足りない場合
    （`bytesAvailable > bytesReturned`）、MCP 経由の Base64 往復

## LOB からの積み残し（2026-07-20 追記）

`20260720-sql-lob-locator` の review で挙がったもの。

- [x] **LOB をまとめて取る要求形式があるか原典で確認する**
  - 現状は LOB セルの数だけ往復する（100 行 × 1 列なら 100 往復）。
    実機は 1 往復 4〜7 秒なので現実的でない
  - 既定では取りに行かないため既定利用では 0 往復だが、
    「無いと決めつけて自前で最適化する」のは避けた。**まず原典を確かめること**
    → `20260801-lob-batch-retrieval-research`（PR #243）で確認。**まとめ取りの形式は無い**。
      `0x1816` はロケーターを 1 つしか取らず（JTOpen `DBSQLRequestDS.setLOBLocatorHandle` は
      int 単数）、要求 ID を全列挙しても LOB 用は **取得 0x1816 / 書き込み 0x1817 /
      解放 0x1819 の 3 つだけ**。**原典も 1 個ずつ取っている**。
      経緯は `.aidev/works/20260801-lob-batch-retrieval-research/research.md`、
      要点は `packages/hostserver/src/db/lob.ts` の冒頭にも残した
- [x] **LOB フィールドしきい値を上げて往復を消す道を検討する**（上の調査の続き）
  - 原典が往復を減らすのは**まとめ取りではなくしきい値**（`0x3822`）。
    超えた LOB だけがロケーターになり、以下は**行データに載って返る**（追加の往復 0）
  - ~~**実機が要る**: …「型コードで判定して 4 バイトのロケーターを読む」が成立するか~~
    → `20260801-lob-threshold-realhost`（PR #245）で実測。**成立しない。ただし静かには壊れない**
      ——しきい値以下の LOB は**型コードごと変わる**（`964 CLOB_LOCATOR` → `408 CLOB`）ので、
      旧コードは `HOST_SERVER_UNSUPPORTED` で**その場で落ちた**。列がずれる心配は無かった
  - **実装した**（既定は 0 のまま。明示指定のときだけ上げる）:
    `DbConnectOptions.lobFieldThreshold`／`clampLobThreshold`（非有限は 0 へ倒す・上限 15,728,640）／
    `db-decode.ts` にインライン LOB の復号。**並びは 4 バイト接頭辞ぶんずれる**——
    CLOB/BLOB は**バイト数**、**DBCLOB は文字数**（バイト数はその 2 倍）
  - 実測（`SELECT` で LOB セル 6 個・SR-OSAKA）: しきい値 0 で中身を取ると **12 往復 /
    132,757 バイト**、しきい値 65,536 なら **4 往復 / 5,078 バイト**。
    中身を取らない既定（4 往復 / 982 バイト）と比べると**行は 5.2 倍**にふくらむ
  - 再現: `scripts/research-lob-threshold-osaka.mjs`
- [ ] **しきい値をアプリから指定できるようにするか決める**（上の続き）
  - ライブラリには入ったが、`/api/host/sql` も MCP `host_sql` も**渡す口が無い**。
    使い道（1 ページだけ見る／CSV に落とす等）が固まってから決める
  - **効果が最も大きいのは PUB400（1 往復 4〜7 秒）**だが、そちらでは未実測
- [x] **ロケーター経由の DBCLOB が壊れている**（`20260801-lob-threshold-realhost` F5 で発見）
  - 既定経路（しきい値 0）で DBCLOB(CCSID 1200) の中身を取ると、`日本語` が **3 バイト**、
    `全角混在ab` が **6 バイト**で返る（正しくは 6 / 12）
    → `20260801-dbclob-locator-decode`（PR #248）で修正。**原因は 2 つあった**:
      1. **申告長の単位**——`lobData`（CP `0x380f`）の長さは
         **2 バイト/文字の CCSID（UTF-16 / 純 DBCS）でだけ文字数**、混在・SBCS はバイト数。
         一律バイト数として読んで**半分に切っていた**
      2. **UTF-16 を復号していなかった**——`query.ts` の `decodeLob` が `codecForCcsid` しか
         試さず、CCSID 1200 で失敗してバイト列のまま返していた
    - **根は判定の重複**。`db-decode.ts` は同じ CCSID を扱えていたのに、
      `query.ts` に別実装があって片方だけ正しかった（PR #242 の `isLob` 型重複と同じ形）。
      `isTwoByteCcsid` / `decodeLobBytes` を `db-decode.ts` に集約し、`query.ts` の実装は**削除**
    - **混在 CCSID の CLOB は元から正しい**（申告長＝SO/SI 込みのバイト数）。実機で前後とも確認
    - 再現: `scripts/research-dbclob-locator-osaka.mjs`
  - ⚠ **SBCS だけで試すと文字数＝バイト数で一致し、取り違えが結果に出ない。**
    同じ罠をインライン経路（PR #245）でも踏んでいる。**LOB の長さは必ず全角で確かめること**
- [x] **純 DBCS の DBCLOB（CCSID 16684 / 300 など）を実機で確かめる**（上の続き）
  - `isTwoByteCcsid` には含めたが、**その CCSID の DBCLOB 列を作って測ってはいない**
    → `20260801-pure-dbcs-dbclob`（PR #251）で **CCSID 300** を実測。
      **ロケーター経由・インラインの両方で正しい**（`日本語` → byteLength=6 /
      `全角混在` → 8）。申告長が**文字数**であることも生バイトで確認（3 → 6 バイト）。
      **PR #248 の実装は純 DBCS でも正しく、コード変更は不要**だった
    - ⚠ **16684 は確かめられなかった**——この実機に変換表が無い（1200 経由でも `-332`）
    - **純 DBCS の列を作るときは 1200 を経由する**。ジョブの CCSID からの直接変換は
      `-332/57017` で通らない: `CAST(CAST('…' AS DBCLOB(1K) CCSID 1200) AS DBCLOB(1K) CCSID 300)`
    - 再現: `scripts/research-pure-dbcs-lob-osaka.mjs`
- [x] **64KB を超える LOB の分割受信と、LOB の打ち切り（`too-large`）を実機で確かめる**
  - PR #248 / #251 で長さの単位を直したが、**1 応答に収まる値でしか測っていない**。
    分割受信が跨ぐ場合と、`too-large` が正しく立つかは未実測（UTF-16・純 DBCS の両方）
    → `20260802-lob-multi-segment`（PR #289）で消化。**未検証ではなく壊れていた。**
  - **ホストは位置も要求量も「文字」で数える**（実機 SR-OSAKA で確認）。
    `lobStartOffset` / `lobRequestedSize` / 申告長 / 総長——**全部が文字単位**。
    `retrieveLob` はそこにバイトを入れていたので、2 バイト CCSID で分割が 2 周目に入ると
    **位置が 2 倍に飛んだ**: 524,288 バイトの `DBCLOB(1200)` から
    **文字 65,535〜131,069 の 65,535 文字が丸ごと欠落**（`lob.ts:47` の `SEGMENT_BYTES`
    という**誤名が入口**。`SEGMENT_UNITS` に改めた）
  - ⚠ **穴の空いた値に `too-large` が付いていた**のが最悪。あの印は「先頭から順に取れて
    末尾で切れた」と読ませるので、**中抜けに気づけない**。
    検査は件数ではなく**先頭からの連続性**で行うこと
  - ⚠ **上限（`lobMaxBytes`）も 2 倍に膨らんでいた**——`maxBytes=200,000` に対し
    **262,140 バイト**を保持。メモリを掴まないための上限が効いていなかった
  - ⚠ **既定値では分割経路を通らない**（`SEGMENT_UNITS` 65,535 に対し既定上限 65,536）。
    **これが PR #248 / #251 の実機確認をすり抜けた理由。** 既定値で測っても分割は起きない
  - **これで LOB の長さの単位を踏むのは 3 度目**（#245 インライン / #248 ロケーター /
    今回 分割）。いずれも「SBCS で通ったから良し」ですり抜けている
  - 再現: `scripts/research-lob-multi-segment-osaka.mjs`（往復を生で覗く）/
    確認: `scripts/verify-lob-multi-segment-osaka.mjs`（14/14）
  - 実機なしの回帰: `packages/hostserver/test/lob-multi-segment.test.ts`
    （**文字で数える偽ホスト**。未修正のコードに当てると 6 件落ち、
    その値 `131070` / `262140` は実機の実測と一致する）
- [x] 純 DBCS（CCSID 300）と BLOB の **64KB 超**を実機で測る（上から分割）
  - ~~`isTwoByteCcsid` は 1200 と同じ枝／BLOB は `perChar=1` で混在 CLOB と同じ経路なので
    **同じ道を通る**と判断して押した~~ **← 押した判断は事実ではない。**
    → `20260802-lob-big-dbcs-blob`（PR #290）で実測（18/18）。
      **純 DBCS は推論どおり／BLOB は推論の外に事実があった**
  - **BLOB の CCSID は `0` ではなく `65535`**（0xFFFF＝IBM の「変換しない」）。
    `decodeLobBytes` は `0` しか見ておらず、**`catch`（未知の CCSID はバイト列で返す）に
    落ちて偶然正しかった**——65535 に codec を足した瞬間に BLOB が黙って文字列へ化ける形。
    doc（`@param ccsid 0 なら BLOB`）も嘘だった
    - **同じ判定が 3 か所にあり 1 か所だけ欠けていた**（`db-reply.ts:108` /
      `marker-encode.ts:233` は正しかった）。`isBinaryCcsid` に集約
      （`20260801-dbclob-locator-decode` の「判定の重複」とまったく同じ形）
  - **純 DBCS の 64KB 超は作れた。** 種だけ 1200 経由の二段キャストで作れば、
    **連結（`P || P`）は同じ CCSID どうしなので変換が要らない**——15 回で 524,288 バイト。
    `20260801-pure-dbcs-dbclob` は小さな値しか作っておらず、作り方が未知のままだった
  - ⚠ **CCSID 16684 は測れない**（変更なし）。この実機に変換表が無いことを
    `20260801-pure-dbcs-dbclob` で実測済み（1200 経由でも `-332`）。**別の実機が要る**
  - 再現: `scripts/research-lob-big-dbcs-blob-osaka.mjs` /
    確認: `scripts/verify-lob-big-dbcs-blob-osaka.mjs`
- [x] **`unavailable` に `"failed"` を足す**
  - 取りに行って失敗した場合に `"not-requested"`（要求していない）と表示され、
    **嘘に近い**。型を 1 つ足すだけだが server / web-ui / CSV に波及する
    → `20260801-sql-lob-failed-state`（PR #240）で消化。
      `packages/hostserver/src/db/db-decode.ts:50` の union に `"failed"` を足し、
      `query.ts:471` の catch がそれを入れる（`{ ...value }` でロケーターと `maxSize` は残す）。
      表示は `SqlResultTable.vue:83,95`（`(LOB: 取得失敗)` ＋「ログに理由が出ます」）と
      `csv.ts:25`（`(LOB: 取得失敗)`。**空欄にしない**——NULL と混ざる）
    - ~~server / web-ui / CSV に波及する~~ **server（`/api/host/sql`）と MCP（`host_sql`）は
      無変更で済んだ**。どちらも行を `bigint → string` だけで JSON にしており LOB 固有の整形が無く、
      MCP の `outputSchema` も `rows: z.array(z.record(z.string(), z.unknown()))`
      （`packages/server/src/host-server-tools.ts:151`）で値を制約していない
    - 併せて失敗理由のログを `debug` → `warn` に上げた（`query.ts:467`）。
      画面が「サーバーのログに理由が出ます」と案内する以上、既定の sink で消えては嘘になる
    - 回帰テスト 12 件（`packages/hostserver/test/lob-fill-failure.test.ts` 5 件 /
      `packages/web-ui/test/csv.test.ts` 5 件 / `packages/web-ui/test/sql-pane.test.ts` 2 件）。
      **変更を外すと 8 件落ちる**ことを実測済み（空振りでない。
      catch の値・ログレベル・画面・CSV の 4 か所を元に戻して計測: hostserver 4 / web-ui 4）
- [x] BLOB（バイナリ）と中身のある DBCLOB での検証（CLOB でしか試していない）
    → `20260801-lob-threshold-realhost`（PR #245）で実測（`ASAOLIB.LOBTHR` に
      `BLOB(1K)` と `DBCLOB(1K) CCSID 1200` を作った）。**BLOB は両経路とも正しい**。
      **DBCLOB はロケーター経由が壊れている**ことが分かった（上の新項目）
- [x] **原典に解放の要求があるか**（上の項目から分割）
  - ~~**原典に該当の要求があるかも未確認**~~ → **在る**。`FUNCTIONID_FREE_LOB = 0x1819`
    （`20260801-lob-batch-retrieval-research`・PR #243）。`JDLobLocator.free()` が使う。
    要求はロケーターハンドル（`0x3818`）**1 つだけ**、ORS ビットマップは **RETURN_DATA のみ**。
    **戻りのエラーは原典も握り潰している**（`7,-401` は「既に解放済み」の意。
    コメント曰く "host now has various errors if locator is already freed"）
- [x] ロケーターの明示的な解放を**実装する**（~~接続を閉じれば消えると見込んでいるが未確認~~）
    → `20260801-lob-locator-free`（PR #246）。`freeLob(conn, locator)` を実装し公開した。
      **`fillLobs` には組み込まない**——実測で
      **接続を閉じればロケーターは消え、次の接続では同じ番号が配り直される**と分かったので、
      単発接続のこのプロジェクトでは要らない。組み込むと
      「失敗したセルも `locator` を残す＝取り直す手がかり」（`20260801-sql-lob-failed-state`）が死ぬ
    - 実測（`scripts/research-lob-free-osaka.mjs`）: 解放後の取得は `rcClass=2 / -815`。
      **二重解放は `rcClass=2 / -816`**——**原典のコメントが挙げる `7 / -401` とは違う値**
      （原典自身が「host now has various errors」と書いており版数で変わる）。両方を静かに扱う
    - `-815` は「別接続で使った」ではなく「**そのロケーターは無い**」の意だと分かった
      （解放後も同じコードが返る）

## サービス型セッションの常駐化（2026-07-24 追記）

`20260723-dtaq-watch-notify` の research で判明した構造上の限界から起票。

**現状の問題**: `/ws` は 1 接続 = 1 セッションで、ソケットが閉じると `onSocketClose` →
`dispose()` → `sessions.close()` が走り**セッションごと破棄される**
（`packages/server/src/app.ts:227-252`, `ws-handler.ts:79-82,249-259`）。
そのため**自動 PDF 保存・自動印刷を設定したプリンターセッションも、ブラウザを閉じた時点で止まる**。
自動出力は `deliverReport` の中でセッション由来のイベントとして走るため
（`session-manager.ts:449-470`）、セッションが消えれば出力も消える。
MCP から開いたセッションはプロセスが生きている限り残るので、能力ではなく **WS への束縛**が原因。

**方針**: セッションを 2 種に区別する。

| | 対話型（揮発してよい） | サービス型（常駐すべき） |
|---|---|---|
| 例 | エミュレーター（display） | 自動出力付きプリンター、データ待ち行列監視 |
| 主体 | 人が画面を触る | 設定が仕事をする |
| 寿命 | タブ/ソケットと一緒 | サーバー設定が生きている限り |

display のサーバー設定は **CI プロファイルの定義**が目的なので、対話型のままでよい。

- [x] **自動出力付きプリンターセッションを常駐化する**
  - **2026-07-30 追記: 常駐の一般形は入った**（`20260723-dtaq-watch-notify`）。
    `packages/server/src/watch-registry.ts` が「サービス型の常駐ジョブ」を持つレジストリで、
    種類は `kind` で分けている（今は `"dtaq"` だけ）。**WS から独立**していて、
    ブラウザを閉じても・タブを閉じても止まらない。プリンターはここに `kind: "printer"` として
    乗せられる形にしてある
  - 併せて分かったこと: **長時間アイドルは越えられる**（45 分で実測）。
    core に TCP キープアライブを入れたので、切れたときの検出も効く
  - 残る論点: プリンターは**受信したスプールの出力（PDF・印刷）まで常駐で行う**ので、
    監視より「失敗の見せ方」が重い（出力の失敗は `outputWarnings` に溜まるが、
    ブラウザが居ないと誰も見ない）。通知の置き場を決めてから着手すること
    → `20260801-printer-session-residency`（PR #252）で対応。
      **実機で「ブラウザを閉じても帳票が届き PDF が保存される」を通した**
    - **常駐の条件は `output`（自動出力設定）の有無**。それはサーバー設定由来のときしか
      供給されない（`config-resolver.ts` の信頼境界 5 層目）ので、
      **常駐の条件と信頼境界がちょうど重なる**。新しい判定軸を足していない
    - **`WatchRegistry` へは移さなかった**。「乗せられる形」とあったが受け皿は `kind` という
      名前だけで、実装は dtaq 密着。移すと「役割の異なるものを同じ箱に入れる」新しい違反になる
      （design D1）。`SessionManager` に `resident` の印を付けた
    - **通知の置き場**（前提条件）は「ログ（既にある）＋ 一覧 API `GET /api/printers`（新設）
      ＋ 再接続時の配り直し（土台は既にある）」の 3 層。**新しい通知基盤は作らない**
    - **上限は別枠**（`maxResidentPrinters` 既定 4）。表示の枠を食うと
      「帳票を待たせておくと画面が開けない」という説明しにくい失敗になる
    - 実機の再現: `scripts/verify-printer-residency-osaka.mjs`
      （⚠ ライターは自動では上がらない＝`STRPRTWTR` が要る。前の実行の残骸が装置を掴むので
      開始時に `ENDWTR` ＋ `CLROUTQ` する）
- [x] **常駐プリンターを画面から扱えるようにする**（上の続き）
  - ~~サーバー側は入ったが **UI が無い**~~ **← 起票時の記述。3 作業で順に閉じた**。
    一覧・開始・停止は `20260801-services-pane` / `20260801-service-control-ui`
    （`ServicesPane.vue`）、出力の警告も同じ画面（`自動出力の警告` 節）
  - ~~**常駐はプロセス再起動で消える**（設定から起動し直す仕組みは無い）~~
    → `20260801-boot-autostart`（`boot-autostart.ts`）で**サーバー起動時に立ち上げる**。
      消えるのは**溜まっていた帳票**であって待ち受けではない（帳票の永続化はしていない）
  - 残っていたのは「**未読の帳票が読める**」だけで、しかも**配線は途中まで出来ていた**
    → `20260802-printer-report-history`（PR #288）で消化。
      `ws-handler.ts:493` は `printer-opened.reports` を送っていたのに、
      **`session-controller.ts` が `reports: []` と書いて捨てていた**——
      `20260801-printer-attach-by-ref` の tasks が T1〜T4 とも server 側で、
      **web-ui を触るタスクが 1 つも無かった**（計画の穴が実装の穴になった）
    - **受信時刻をサーバーで刻む**（`session-manager.ts:833` の `deliverReport`）。
      それまではクライアントが `Date.now()` を押しており、夜中に出た帳票が
      **全部「いま届いた」**になっていた。`StoredReport = SpoolReport & { receivedAt }`
      ——プロトコル層（`@as400web/tn5250`）は時計を持たないので派生型にした
    - **live と配り直しで同じ関数を通す**（`ws-handler.ts:45` の `spoolReportMsg`）。
      片方だけ載せると「開き直すと時刻が出るのに、いま届いたものには無い」差になる
    - **未読は水増ししない**（受け取るのは既存分）。**累計はサーバー値から +1**
      （`reports.length` で数え直すと落ちた分がクライアントで消える）
    - `ServicesPane` から `開く`（`composables/openConfigured.ts` をランチャーと共用）。
      **`editable` で隠さない**——読むだけなので開始/停止（admin）とは条件が違う
    - 実機の再現: `scripts/verify-printer-report-history-osaka.mjs`（13/13）。
      **`WsConnection` を通す**のが要点で、時刻は**不等式**
      （`閉じた < 受信 ≦ 到着 < 開き直し`）で検査する——値の有無だけだと直す前でも通る
  - ~~`20260723-dtaq-watch-notify` で作る常駐レジストリに**後から乗せられる形**にしておくこと~~
    → `20260801-printer-session-residency` design D1 で**乗せない**と決めた
      （`WatchRegistry` の実装は dtaq 密着で、移すと別の違反になる）
- [ ] 常駐プリンターを**長時間（数時間〜数日）保てるか**を測る（上から分割）
  - DTAQ 監視では 45 分のアイドルを越えられている。プリンターは未測定
  - **50 件を超えて古い帳票が落ちた状態も実機で作っていない**
    （`REPORT_LIMIT`。単体では `printer-residency.test.ts` が 60 件投入で押さえている）
    （同作業では DTAQ 監視のみ実装し、プリンターは触らない）
  - 併せて検討: `SessionManager` の 30 分アイドル掃除（`session-manager.ts:279-284,684-694`）は
    常駐サービスには効かせない。上限 8（表示・プリンター合算）の枠の扱いも決める
