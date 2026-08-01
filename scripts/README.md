# 実機 E2E / 診断スクリプト

`packages/tn5250` の `Session5250`（および MCP/WS）を実 IBM i（既定 pub400.com）に対して動かす E2E・診断スクリプト。

## 実行方法

ビルド後、資格情報を環境変数で渡して実行する（`.env` は gitignore、パスワードはコミットしない）:

```sh
npm run build
node --env-file=.env scripts/<name>.mjs
```

必要な環境変数: `PUB400_USER` / `PUB400_PASSWORD`（自動サインオン）。任意: `PUB400_HOST`（既定 pub400.com）、
`PUB400_DEVNAME`、`PUB400_LIB`（既定 MYLIB）。各スクリプトは成功で終了コード 0、失敗で 1。

## 検証に使う実機

| 機械 | 版数 | パスワードレベル | 備考 |
|---|---|---|---|
| **実機**（社内・LAN） | **IBM i 7.3**（`V7R3M0`） | **0**（DES 経路） | CCSID 5035 / SBCS は 5026 系。ライブラリ `TESTLIB` |
| **PUB400**（インターネット・TLS） | IBM i 7.5（`V7R5M0`） | 3（SHA 経路） | ライブラリ `MYLIB`。1 往復 4〜7 秒 |

> ⚠ **2026-08-01 より前の記録は実機を「IBM i 7.5」と書いているが誤り。**
> `.aidev/works/*` の research / walkthrough 等 15 件超が該当する（過去の記録なので
> 書き換えていない）。**7.3 で測った結果**として読むこと
> （経緯は `.aidev/works/20260801-realhost-version-and-pwdlevel/`）。

版数は**表示 1 つを信じず 2 経路で**確かめる。「実機も 7.5」は、おそらく誰も測らずに
書かれて広まった:

```sh
# 1. サインオンサーバーの VRM
node --env-file=.env tools/hostserver-check/dist/main.js --host "$AS400_HOST"
#    → "server version : V7R3M0" / "password level : 0"

# 2. 累積 PTF パッケージ（ID は Cyyddd<rrr> で末尾 3 桁が版数）
node --env-file=.env tools/hostserver-check/dist/sql.js \
  "SELECT PTF_GROUP_NAME, PTF_GROUP_DESCRIPTION FROM QSYS2.GROUP_PTF_INFO"
#    → SF99730 / "CUMULATIVE PTF PACKAGE C9116730" ＝ 7.3.0
```

`QSYS2.ENV_SYS_INFO` は実機に**無い**（`SQLCODE=-204`）ので、版数の確認には使えない。

> PUB400 は切断後もデバイスをしばらく保持するため、同名デバイスへの即再接続は
> `closed during negotiation` になりやすい。E2E 系はリトライごとにデバイス名を変える。

## 表示属性 E2E（DBCS・文字色・背景色・属性・インライン色）

`MYLIB` に作った 2 組の DDS/RPGLE フィクスチャで、エミュレーターの属性デコードを検証する。

- **CLRTDSP/CLRTPGM** — フィールド単位の `COLOR`/`DSPATR` ＋ DBCS(日本語) 出力欄（表示）
- **INLTST/INLPGM** — インライン色制御（フィールドデータ中に属性バイト 0x20–0x3F を埋め込み、桁ごとに色切替）（表示）
- **INPTST/INPPGM** — フィールド型別の入力（数値/A(SBCS)/O(open)/J(pure DBCS)）＋DBCS 日本語のエコー往復（入力）

| スクリプト | 内容 |
|---|---|
| `build-attrtest.mjs` | `MYLIB` に上記 3 組を作成・コンパイル（冪等）。ソースはコマンド行から `RUNSQL INSERT` で投入（IFS 不要）。 |
| `verify-attributes.mjs` | 表示検証: `CLRTPGM`（7 色・反転・下線・高輝度・桁区切り・点滅・DBCS）＋ `INLPGM`（埋め込み属性バイトの色切替）。**CCSID 1399**。 |
| `verify-input.mjs` | 入力検証（core）: `INPPGM` の 4 欄の型（numeric/SBCS/open/pure）＋ O/J のエコー往復。**CCSID 1399**。 |
| `verify-browser-dbcs.mjs` | 入力検証（実ブラウザ）: DBCS 往復＋**フィールド型ルール**（J は SBCS 不可・A は DBCS 不可・NUM は英字不可）を実 IME(CDP)で。 |
| `verify-browser-render.mjs` | 描画回帰（実ブラウザ）: 反転(背景色)セルの文字色≠背景色（文字が見える）／DBCS 全角の縦位置が同行テキストと揃う、を計算スタイル・幾何で検証。 |
| `verify-browser-select.mjs` | 矩形選択回帰（実ブラウザ）: カーソルが選択の始点に置かれ、マウス／キーボードで広げても動かない（ACS 相当）／ダブルクリックで語を選択（入力欄上の native 語選択を畳んで blur できるか）／カーソルが選択ハイライトより上に描かれる（jsdom は scoped CSS を解決しないため）。 |
| `verify-browser-paste.mjs` | 複数行ペースト回帰（実ブラウザ・12 項目）: `STRSQL` の SQL 入力エリア（独立した入力欄が縦に並ぶ）へ矩形の形のまま落ちる／書いた範囲だけ上書きし後ろの既存文字を残す（`123456` へ `789` → `789456`）／行またぎ欄（コマンド行）でも折返し先の同じ桁へ落ちる／帯の幅で折り返しあふれは次の帯行の同じ桁へ／挿入モードは後続を右へずらし入り切らねば「挿入する余地がありません」で何も書かない／ペースト後もカーソルが動かない。**SQL は実行しない**（Enter を押さない）ためホストは変更しない。 |
| `verify-browser-adjust.mjs` | ローカル編集キーと FFW の ADJUST 回帰（実ブラウザ・実機・15 項目）: Field Exit（Ctrl+Enter）がカーソル以降を消して `CHECK(RZ)`＝ゼロ埋め／`CHECK(RB)`＝空白埋めで右寄せし次の欄へ進む／`CHECK(MF)` は桁を動かさない／符号付き数値欄は指定が無くても空白右寄せし符号桁を残す／Erase EOF（Ctrl+Delete）は消すだけで欄を出ない／Erase Input（Ctrl+Backspace）で全欄クリア。**最後に Enter を送り、ホストが受け取った値（`[000012]` / `[    12]`）まで確かめる**。**要 `TESTLIB/ADJPGM`**（`build-adjtest.mjs`）。 |
| `verify-screen-size.mjs` | 画面サイズ検証: 24x80 / 27x132 × SBCS / DBCS の端末タイプと、`STRSEU`（*DS4 を持つ画面）が実際にワイドで来るか。DBCS はカラー端末（G02/C01）を掴めているかも見る。**要 `MYLIB/QDDSSRC`**。 |
| `verify-printer.mjs` | プリンターセッション検証（core・実機）: `PrinterSession` で待ち受け → 表示セッションから自前スプールをそのプリンター OUTQ へ回し（`CHGJOB OUTQ`＋`DSPLIBL OUTPUT(*PRINT)`）→ ライターの用紙タイプ問い合わせ（`CPA3394`）に `I` で応答 → SCS を受信して "Library List" 帳票を桁揃えで展開できることを確認。**自分のデバイスにのみスプールを回す**ためホストを汚さない。 |
| `verify-printer-dbcs.mjs` | DBCS プリンター検証（core・実機・CCSID 1399）: `MYLIB` のライブラリテキストを日本語に変えて `DSPLIBL` を印刷 → SCS 中の SO/SI 付き全角を受信し、帳票に日本語が桁揃えで載ることを確認（検証後にテキストを戻す）。**要 MYLIB**。 |

```sh
node --env-file=.env scripts/build-attrtest.mjs      # 初回/再作成（既存なら不要）
node --env-file=.env scripts/verify-attributes.mjs   # 表示検証
node --env-file=.env scripts/verify-input.mjs        # 入力検証（core）
node --env-file=.env scripts/verify-browser-dbcs.mjs # 入力検証（ブラウザ/IME）
```

補足:
- 実機では素の `DSPATR(BL)` はホストが赤・非点滅(0x28)を送るため、点滅は `COLOR(RED) DSPATR(BL)`(0x2A) で検証する。
- **DBCS（日本語）は CCSID 1399 のセッションが必須**。既定 `pub400`(CCSID 37) では表示も入力もできない。
  `profiles.json.example` の `pub400jp`(CCSID 1399) のように DBCS プロファイルを用意して接続する
  （ブラウザ操作でも同様。手動接続フォームなら CCSID に 1399 を指定）。ブラウザでの日本語入力は IME 経由（compositionend で取り込み）。
- DBCS 入力欄は DDS データ型 `O`（DBCS-open）。フィクスチャは E2E 再利用のため MYLIB に残置している。

## テスト自動化のテンプレート

`example-automation.mjs` は **Session5250 でテスト自動化を書くための雛形**（LLM 非依存・ヘッドレス。
自動化の三択のうち「決定論的ヘッドレス」＝最軽量。CI/リグレッション向き）。

- 極小ハーネス `test(name, fn)` ＋ `assert()` で pass/fail 集計 → `process.exit`。
- 薄い `Host` ドライバ: `connect()`（デバイス名を変えてリトライ＋メニュー待ち）/ `run(cmd)`（コマンド行→Enter）/
  `key(k, cursor)` / `waitText(t)` / `text()` / `at(r,c)`（セル属性でアサート）。
- 「接続 → 操作 → アサート → `finally` で後始末」を素直に書く。

```sh
node --env-file=.env scripts/example-automation.mjs
```

要点: `sendAid` にカーソル桁を載せる／`waitForScreen(until.text)` でホスト応答をサーバ側ブロック待ち（ポーリング不要）／
`host.at(r,c).color` 等でセル単位に属性検証。新しい実機テストはこれをコピーして書き足すのが早い。

## PC コマンド（STRPCO / STRPCCMD）

ホストが 5250 の画面データに隠して送ってくる PC コマンドを、エミュレーター側で実行する機能の検証。
バイト列は推測せず実機で採った（`docs/PROTOCOL.md` §4.5 ／ `.aidev/works/20260728-strpco-strpccmd/research.md`）。

| スクリプト | 内容 |
|---|---|
| `build-pcotest.mjs` | 実機の `TESTLIB` にテスト CL を作成（冪等）。`PCOTEST`＝データ域 `PCOCMD`/`PCOWAIT` を読んで `STRPCO`→`STRPCCMD` を実行し、前後で `PCOMARK` を書き換える。`PCO123`＝123 文字コマンド（行を跨ぐ配置の確認用）。**`ADDPFM` の `SRCTYPE(CLP)` が要る**（省くと `CPF0820` でコンパイルできない）。 |
| `verify-pcocmd.mjs` | 実機 E2E。`PAUSE(*YES)` / `PAUSE(*NO)` / 機能無効 / 許可リスト外の 4 ケースを別セッションで実行し、**ファイルが作られたか**で判定する（ホストは実行の有無を検証しないため、画面が進んだことは証拠にならない）。 |
| `research-strpco.mjs` / `2` / `3` | 調査用。`traceRecords` で受信レコードを hex 採取（1）、`STRPCO`/`STRPCCMD` の F4 プロンプトと QSYS の PC 系コマンド一覧（2）、テスト CL 経由の長いコマンド（3）。 |

```sh
node --env-file=.env scripts/build-pcotest.mjs    # 初回/再作成
node --env-file=.env scripts/verify-pcocmd.mjs    # E2E（28 アサーション）
```

注意:
- **同じジョブで `STRPCO` を 2 回実行すると `IWS4010`** になる。1 セッション 1 回に留める。
- `STRPCO` を先に実行しないと `STRPCCMD` は**何も送ってこない**（画面は変わらず CL は先へ進む）。
- 採取した生ログにはサインオン画面が写る。解析が済んだら削除する。

## FFW の ADJUST（右寄せ）とローカル編集キー（実機 / TESTLIB）

FFW の ADJUST 指定に基づく右寄せと、Field Exit / Erase EOF / Erase Input の検証。
**右寄せは端末の仕事**（ホストは整形しない）ことを実測で確かめてから実装した
（`.aidev/works/20260729-field-adjust-local-edit-keys/research.md`）。

| スクリプト | 内容 |
|---|---|
| `build-adjtest.mjs` | 実機の `TESTLIB` に `ADJDSPF`/`ADJPGM` を作成（冪等）。`CHECK(RZ)/(RB)/(MF)/(FE)/(ME)` を付けた英数字欄・素の欄・ゾーン数値欄・符号付き数値欄を並べ、`exfmt` の後に受信値を `[...]` で囲んで出力欄へ写す（**前後の空白が画面から読める**）。 |
| `research-adjust.mjs` | 調査用。`traceRecords` の生データストリームを **core を通さず独立にパース**して SF オーダーの FFW を並べる（検証対象の実装に依存させないため）。DDS の `CHECK(...)` がどのビットになるかを実測する。 |
| `research-adjust-roundtrip.mjs` | 調査用。同じ値を「左詰めのまま」と「右寄せ済み」で送り、ホストが受け取った値を突き合わせる。**英数字欄はホストが整形しない／数値欄は吸収される**ことがこれで分かる。 |
| `verify-browser-adjust.mjs` | 回帰 E2E（実ブラウザ＋実機・15 項目）。上の表を参照。 |
| `build-ffwtest.mjs` | 実機の `TESTLIB` に `FFWDSPF`/`FFWPGM` を作成（冪等）。DDS 35 桁のキーボード・シフト（`A`/`X`/`N`/`W`/`D`/`I`/`M`）と `CHECK(LC)` / `CHECK(ER)` を並べる。**1 件ずつ単独でコンパイルして通る指定を切り分けてから**本番の 1 レコードに束ねる（まとめて 1 回だけ試すと、どれが落としたか分からない）。 |
| `research-ffw.mjs` | 調査用。(A) `ADJPGM` で `CHECK(ME)` を空・`CHECK(MF)` を部分入力のまま Enter を送り、**ホストが検証するかどうか**を切り分ける。(B) `FFWPGM` の FFW を採る。 |
| `probe-signon-ffw.mjs` | 調査用。**サインオン画面に必須指定が無い**ことの確認（Enter の必須検証がサインオンを塞がない根拠）。 |
| `verify-browser-ffw.mjs` | 回帰 E2E（実ブラウザ＋実機・18 項目）。MONOCASE / `CHECK(LC)` / 英字専用（`X`）/ キーボード入力不可（`I`）/ AUTO_ENTER（`CHECK(ER)`）/ FER（`CHECK(FE)`）/ 必須検証（`CHECK(ME)`・`CHECK(MF)`）と **F3 は止めない**こと。**要 `TESTLIB/ADJPGM` と `TESTLIB/FFWPGM`**。 |

| `build-sgntest.mjs` | 実機の `TESTLIB` に `SGNDSPF`/`SGNPGM` を作成（冪等）。符号付き数値（`6S 0`）・ゾーン数値（`6 0`）・数値のみ文字（`6M`）・`DUP` キーワード付き欄を並べ、受信値を `[...]` で写す。Dup は `x'1C1C1C1C1C1C'` と突き合わせて `[ALLDUP]` を返す。 |
| `research-sign.mjs` | 調査用。**欄ごとに 1 つずつ**送って「どの形なら負値として届くか」を切り分ける。混ぜて送ると CPF5257 がどの欄由来か分からない。 |
| `verify-browser-sign.mjs` | 回帰 E2E（実ブラウザ＋実機・9 項目）。Field−（`[-12]`）／ Field+（`[34]`）／ Dup（`[ALLDUP]`）／ `DUP_ENABLE` でない欄では効かないこと。**要 `TESTLIB/SGNPGM`**。 |
| `build-edttest.mjs` | 実機の `TESTLIB` に `EDTDSPF`/`EDTPGM` を作成（冪等）。`EDTCDE` / `EDTWRD` を**用途 B（入出力両用）**に書けるかを 1 件ずつ単独コンパイルで確かめる。 |
| `research-edtcde.mjs` | 調査用。編集コード／編集語つきの入力可能欄が、ワイヤ上**分解されるのか・編集文字を含んだまま 1 欄で来るのか**を実測する。 |
| `verify-browser-idle.mjs` | 回帰 E2E（実ブラウザ＋実機・11 項目）。**セッションの寿命**: 既定（永続）で 110 秒放置しても切れない（同時に**ハートビートの往復**も検証——pong を返さなければ 90 秒で半開きと判断される）／セッション設定 `idleTimeout: 1` で放置すると **60 秒で切れる**（早くは切らない）／同じ設定でも**打鍵し続ければ切れない**（在席の合図 `activity` が効いている。**AID キーは押さない**）／設定フォームの選択肢。掃除の間隔だけ `startIdleSweep(2000)` に縮める（判定は実装のまま）。**追加のホスト資産は不要**。 |
| `build-dttest.mjs` | 実機の `TESTLIB` に `DTMDSPF`/`DTMPGM` を作成（冪等）。**`EDTMSK`（編集マスク）つき入力欄**を 8 通り（`&` / 空白 / `&&/&&/&&` のマスク・`EDTCDE(Y)` 単独・`EDTWRD` の時刻・SSN・素の数値）並べる。**マスクの綴りを推測せず 1 件ずつ単独コンパイル**して通る書き方を実機に教えてもらう。DDS の定数は**英数字のみ**（日本語だと `INSERT` が長さ超過する。実測 155 > 153）。`DT_SKIP_PROBE=1` で単独コンパイルを省略できる。 |
| `research-edtmsk.mjs` | 調査用。`DTMPGM` の受信を **core を通さず独立にパース**して SF オーダーを並べ、**`EDTMSK` が欄を分解するか**を見る。**結論: 分解しない**（下記の注意）。 |
| `research-sysval.mjs` | 調査用。日付・時刻のシステム値の引き方を確かめる。**`QSYS2.SYSTEM_VALUE_INFO` は実在**し、値は `CURRENT_CHARACTER_VALUE` に入る（`QDATFMT=YMD` / `QDATSEP=/` / `QTIMSEP=:`）。候補を 1 つに絞らず順に試す形にしてある。 |
| `verify-browser-prompt.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**`F4` の導線**: 設定 OFF では出ない／ON でフォーカス中の欄の隣に出る／**ラベルはホストの凡例の語**（実機は化けたカタカナで来る）／押すと**ホストが実際にプロンプト画面を返す**（メインメニュー → `MAJOR メジャー・コマンド・グループ`）。画面設定メニューの操作（`.vsm-btn` → `.vsm-row` → `.seg button`）も通る。**追加のホスト資産は不要**。 |
| `probe-dtaq-longwait.mjs` | 調査用。**DTAQ の無限待ち接続が長時間アイドルを越えられるか**を実測する（既定 45 分）。`wait=-1` は read タイムアウトを無効にするので、相手が黙って消えても永久に待つ——`--minutes` で待ち時間を変えられる。**結論は下記の注意書き**。 |
| `verify-browser-watch.mjs` | 回帰 E2E（実ブラウザ＋実機・8 項目）。**データ待ち行列の常駐監視**: 監視開始 → 別接続からエントリを送ると**画面操作なしで履歴に現れる**／タブを離れているときに届くと**未読が付く**／開くと消える／**タブを閉じてもサーバー側の監視は残る**／リロード後に再接続しても**二重に監視を始めない**／停止で消える。資格情報は `passwordEnv` で渡す（この環境では `SecretCrypto.fromEnv()` が使えず `passwordEnc` を復号できない）。**キューは自動で作って消す**（`TESTLIB/DTQWATCH`）。 |
| `research-sql-exec.mjs` | 調査用。**結果を返さない SQL 文（DML / DDL）が既存の要求で実行できるか**を実測する。`prepareAndDescribe`(0x1803) → `execute`(0x1805) を**マーカーデータ無し**で送り、CREATE / INSERT / UPDATE / DELETE / DROP・構文誤り・存在しない表・SELECT の経路違い・実ライブラリー（SQL 命名とシステム命名）を 1 件ずつ通す。**表は `QTEMP` に作る**（接続ごとに消えるので後片付けが要らない）。⚠ 成否は **SQLCODE** で見る——`reply.rcClass` は `Reply` に無い欄で、参照すると常に失敗扱いになる（この検証で実際に踏んだ）。 |
| `verify-browser-sql-exec.mjs` | 回帰 E2E（実ブラウザ＋実機・13 項目）。**SQL 画面からの更新**: CREATE（**「実行しました」＋実ライブラリーでは警告 `SQLCODE=7905`**）→ INSERT / UPDATE / DELETE（**「N 行に影響しました」**）→ SELECT で**ホストの表が実際に変わったこと**を確認 → 存在しない表は `SQLCODE=-204` で失敗 → `?` 付きは実行前に断る → `;` 区切りの混在でタブが 2 つ（非クエリと表）→ DROP。表は `TESTLIB/SQLEXECB` を**自動で作って消す**。資格情報は `passwordEnv` で渡す。 |
| `research-sql-cancel.mjs` | 調査用。**結果セットの早期打ち切り**を実測する。上限 1/50/99/100/101/200/250 で打ち切り、**打ち切った直後に同じ接続で SELECT / UPDATE が通るか**・fetch の**往復回数と受信バイト数**・ブロッキング係数を絞った効果・「続きがあるか」を上限＋1 行で判定できるかを並べる。**結論: 打ち切りはホストに副作用を残さない**（20,000 行で全件 201 往復 / 1,191,336 バイト / 2,072ms → 上限 200 で 2 往復 / 11,912 バイト / 44ms）。表は `QTEMP` に作るので後片付け不要。 |
| `verify-sql-limit.mjs` | 回帰（実機・8 項目）。**取得量の上限が MCP と REST の両方で効いているか**。20,000 行の表に対し `host_sql`（実際の登録コードを通してハンドラを呼ぶ）が上限 200 で 200 行＋`truncated: true` を返し、**接続込み 177ms** で終わること／**上限ちょうどでは `truncated: false`**（嘘をつかない）／REST 単発経路（`pageSize` 無し）も同じ。表は `TESTLIB/SQLLIMIT` を自動で作って消す。資格情報は `passwordEnv` で渡す。 |
| `diag-qsh.mjs` | 調査用。**QSH（Qshell）が固まる原因**を実測する。メインメニューで `QSH` を実行し、届いたレコードを**実装と独立に**並べて「どのコマンドで捨てているか」を見る。**結論: `ESC 0x03`（SAVE PARTIAL SCREEN・パラメータ 5 バイト・opcode PUT/GET）に応答していなかった**。装置名は実機に登録済みの名前（`WEBSF0`〜）を順に試し、前ジョブの回復画面は `90` で越える。 |
| `verify-browser-qsh.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**QSH が使えること**: 接続 → メインメニュー → `QSH` で**画面が出る**（従来はここで待機のまま固まった）→ `ls -l /` の出力が読める → 続けて実行すると出力が流れる → F3 で抜ける。装置名は `DEV1` を先頭に空いているものを探す。⚠ 画面の凡例「F3= 終了」と鍵盤ボタンは別物——**ボタンを指定して押す**（`getByText("F3")` は画面の文字に当たる）。 |
| `census-5250-commands.mjs` | 調査用。**実機の画面が実際に使う 5250 コマンドを数える**。読み取り専用の画面 11 件（`STRSQL`/`DSPMSG`/`WRKACTJOB`/`WRKSYSSTS`/`DSPJOBLOG`/`WRKSPLF`/`DSPLIBL`/`WRKOBJ`/`STRPDM`/`GO CMDIFS`/`QSH`）を巡り、各画面で PageDown/PageUp も送る。**正確さの度合いを分けて出す**——レコード先頭（正確）／実装の未知判定（決定的）／全走査（参考。WTD 内の 0x04 も拾う）。結論は `.aidev/backlog/datastream-commands.md`。 |

```sh
node --env-file=.env scripts/build-adjtest.mjs      # 初回/再作成
node --env-file=.env scripts/verify-browser-adjust.mjs    # E2E（15 項目）
node --env-file=.env scripts/build-ffwtest.mjs      # 初回/再作成
node --env-file=.env scripts/verify-browser-ffw.mjs       # E2E（18 項目）
node --env-file=.env scripts/build-sgntest.mjs      # 初回/再作成
node --env-file=.env scripts/verify-browser-sign.mjs      # E2E（9 項目）
node --env-file=.env scripts/verify-browser-idle.mjs      # E2E（11 項目・約 5 分かかる）
```

注意:
- 実測で分かった要点: **DDS の数値入力欄は `6 0`（ゾーン）も `6S 0` も、ワイヤ上は
  `shift=signed-num`・長さ = 桁数 + 1**（最終桁が符号桁）で来る。素の英数字欄には
  `CHECK(LC)` が無い限り **`MONOCASE` が既定で立つ**。
  **`CHECK(ER)` が `AUTO_ENTER`（0x0080）を立てる DDS キーワード**（`Y` は小数位が必須で文字欄にできない）。
- **ホストは `CHECK(ME)` / `CHECK(MF)` を検証しない**（空・部分入力のまま Enter が素通りする）。
  端末が止めなければ誰も止めない。
- **`EDTCDE` / `EDTWRD` は用途 B でも書ける**。そのとき編集文字は**入力欄の中に入って**来る
  （`value="     .00"`・shift=num-only）。分解されない。
- **コマンド行の入力欄は実機で長さ 153**（行またぎ）。画面に部品を重ねるとき
  「欄の右隣」を `col + length` で出すと**画面外に落ちて永久に出ない**。
  `posOfOffset` で欄の終わりを出し、右に場所が無ければ**欄の直前**（SF の属性バイトの桁＝空白）へ
  退避する（`verify-browser-prompt.mjs` で実測して直した）。
- **DTAQ の無限待ち（`wait=-1`）は TCP キープアライブが無いと 45 分で死に、
  エントリが失われる**（2026-07-30・実機で A/B 実測。`probe-dtaq-longwait.mjs --minutes 45`）。
  - **keepalive 無し**: 45 分アイドル後に送ったエントリは**キューから消えたのに `read` は返らない**
    ＝接続は死んでいるのにこちらは気づかず、**ホストが死んだソケットへ払い出して捨てた**
  - **keepalive 有り**（`setKeepAlive(true, 60_000)`。現在の実装）: **45 分を越えて受信できた**
  - `wait < 0` は read タイムアウトを無効にするので、**こちらから死を知る手はキープアライブだけ**。
    常駐監視はそれでも切れたら指数バックオフで張り直す。
- **監視は「同じ設定で 2 本」を作らせない。判定はサーバー側**（`WatchRegistry.start`）。
  画面側だけで見ると**リロード直後は一覧が届いておらず**すり抜ける（実機 E2E で 2 本になった）。
  監視は消費するので、2 本掛かると 1 本ぶんのエントリを取り合って両方が欠ける。
- **`EDTMSK` は欄を分解しない**（2026-07-29・実機・8 通りの DDS で実測）。
  `EDTCDE(Y)` / `EDTWRD` に `EDTMSK` を足しても、**どの綴りでも 1 欄で来て編集文字は欄の中の値に入る**
  （`value=" 0/00/00"`）。マスクは 3 通りとも `CRTDSPF` が通るので、**「書けるか」では
  分解の有無を判別できない**。`.aidev/backlog/input-assist.md` の datepicker が
  これで「作らない」に決着した（判定材料が無い）。**再調査しないこと。**
- **日付・時刻のシステム値**は `QSYS2.SYSTEM_VALUE_INFO` から引ける
  （`QDATFMT` / `QDATSEP` / `QTIMSEP`。値は `CURRENT_CHARACTER_VALUE`）。
- **セッションの寿命は実測で確かめた**（2026-07-29・実機）: 既定（永続）は 110 秒放置でも切れず、
  `idleTimeout: 1` は **60 秒で切れる**（設定より早くは切らない）。同じ 1 分設定でも **AID キーを押さず打鍵だけ
  続ければ切れない**——在席の合図が 15 秒間引きでも 1 分のタイムアウトに間に合っている。
  110 秒放置で生き残ることは**ハートビート（`ping`/`pong`）の往復が成立している証拠**でもある
  （返さなければサーバーが 90 秒で半開きと判断して畳む）。
- **符号付き数値欄は「符号桁を送らず、最終桁のゾーンを 0xD にする」**。
  `-12`（先頭に符号）は**符号が黙って落ちて `12` になり**、7 バイトそのまま送ると CPF5257。
  DDS の `DUP` キーワードは `DUP_ENABLE`（0x1000）を立て、複写文字は `0x1C`。
- 装置名を使い回すため、前回のジョブが残っていると**回復画面から始まる**。
  `verify-browser-adjust.mjs` は回復（90）と前回の `ADJPGM` 残留（F3）の両方を捌く。
  `verify-browser-ffw.mjs` は**最後に `SIGNOFF` して装置を解放する**——
  解放しないと次の実行が回復画面から始まり、**1 回おきに失敗する**（実測）。

## IFS ファイルブラウザ（実機 / /home/USER）

| スクリプト | 内容 |
|---|---|
| `verify-browser-ifs.mjs` | IFS ペインの操作 E2E（実ブラウザ・実機・18 項目）。`/home/USER/TEST` を作って、**画面の操作だけ**でフォルダ作成／ファイルのアップロード・プレビュー・編集保存・ダウンロード・改名・削除／**フォルダごとのアップロード**（入れ子・日本語名）／zip 一括ダウンロード／フォルダの改名・中身ごと削除まで通す。**API は検証と後始末にしか使わない**（下回りだけ通っても「画面から行えるか」の答えにならない）。 |
| `verify-ifs-limits.mjs` | 上限表示・プレビュー競合・先回り判定の実機検証（15 項目。PR #231）。`/home/asao/test` を作り、`GET /limits`／413 に上限が載ること／**上限超過で read を発行しないこと**／ヌルバイト入りの案内／連続選択で最後の 1 つが残ること／zip の上限文言を見る。 |

要点（`verify-ifs-limits.mjs`）:

- **上限を CLI 引数で下げて検証する**（`ifsReadMaxBytes: 4096` / `ifsZipMaxBytes: 1024`）。
  既定 5MiB の超過を作るには 5MB 超を 100KB/s のホストへ置く必要があり、検証のたびには払えない。
  先回りの分岐は「`sizeHint` > 上限」で決まるので、上限を下げれば**同じ経路**を通る。
  ついでに CLI 引数が `/limits` に反映されることも確かめられる。
- **「read を発行しない」は画面を通さないと確かめられない。** `page.on("request")` で
  `/api/host/ifs/read` を数える。API だけ叩いても答えにならない。
- **一覧に出る名前は `USER`（大文字）。** IFS は解決時に大小を区別しないので API は
  `/home/asao` でも通るが、画面の行を掴むには格納されている綴りが要る。
- **固定待ちにしない。** 実機は 1 往復が数秒（書き込みで 4〜8 秒を実測）で、`sleep(2500)` だと
  「まだ来ていない」を「壊れている」と読み違える。`.preview .path` が変わるまで待つ。
- **本文は `textarea` の value。** `innerText` には出ないので `inputValue()` で取る。

要点（`verify-browser-ifs.mjs`）:

- **保存は元より短い内容で試す。** 長くする編集だと通ってしまう——OPEN を「開くだけ」で書くと
  先頭からの上書きになり、41 バイトのファイルに 19 バイト保存して末尾 22 バイトが旧内容のまま残る
  （実機で踏んだ。`FILE_DUPLICATE.createOrReplace` で修正済み）。ホストの `list` が返すサイズまで見る。
- **「保存しました」を待ってから測る。** クリック直後は busy が立つ前なので、
  待たずに一覧を読むと書き込み前のサイズを掴む。
- **フォルダのアップロードは `input[webkitdirectory]` に*ディレクトリのパス*を渡す**（Playwright ≥1.42）。
  ファイル用の入力とは別物なので、セレクタは `:not([webkitdirectory])` で書き分ける。

```sh
node --env-file=.env scripts/verify-browser-ifs.mjs
node --env-file=.env scripts/verify-ifs-limits.mjs
```

`verify-browser-ifs.mjs` は同じペインの pub400（`/home/USER/ifsdemo`）版。プレビュー（画像・PDF）と
`/QSYS.LIB` の「先頭 N 件まで」はこちらが見ている。

## その他

`verify-autosignon` / `verify-signon` / `verify-mcp` / `verify-ws` / `verify-browser` / `verify-dbcs-tls` /
`verify-gui-enhanced`（各機能の実機検証）、`capture-*`（トレース fixture 採取）、
`diag-*`（signon/PDM 診断・`diag-window-fkey` は DDS 窓で無効キーを押したときのホスト応答）、
`dump-screen`（トレースをオフライン再生）も同じ実行規約に従う。

### 画面採取・実測の族（実機 / TESTLIB）

窓検出・GUI 拡張・F キー凡例・罫線まわりの調査で使った一群。**1 本ずつ表にすると
上の重い表が埋もれる**ので族でまとめる。いずれも実行規約は同じで、接続先は
`AS400_HOST`（既定値なし。未設定なら落ちる）。

| 族 | 本数 | 中身 |
|---|---|---|
| `shot-*` | 15 | 画面・UI の採取。ブラウザ経由（`shot-crt` / `shot-buttons` / `shot-font` / `shot-viewsettings` / `shot-keycycle` / `shot-window-fkey` ほか）と MCP の `get_screen_html` 経由（`shot-signon` / `shot-signedon` / `shot-testlib-screens` / `shot-spool-html` ほか） |
| `build-*` | 3 | `TESTLIB` に DDS/RPGLE のフィクスチャを作る（`empsfl`＝サブファイル / `ext`＝拡張5250 / `feat`＝各種機能） |
| `probe-*` | 3 | 単発の実測。`probe-ccsid`（SBCS が 939 系か 5026 系か）/ `probe-window-signal`（窓の受信データ上の徴候）/ `probe-testlib-refs`（`DSPPGMREF` で表示装置ファイル参照を洗う） |
| `check-*` | 3 | 不変条件の確認。`check-html-determinism`（同じ画面から常に同じ HTML か）/ `check-menu-exclusive` / `check-persist` |
| `diff-*` | 2 | 実機とこちらの出力の突き合わせ。`diff-gridlines`（罫線）/ `diff-webui-vs-host`（web-ui とホスト画面） |
| 単発 | 3 | `list-testlib`（ライブラリの中身一覧）/ `research-ext-gui`（拡張5250 の GUI 要素調査）/ `verify-spool-html`（スプール HTML の検証） |

> 📌 **接続先をハードコードしない。** 出力に焼く説明文（HTML のメタ・画像の注記）も
> `AS400_HOST` から組む——固定文字列にすると、別ホストへ繋いだのに説明文だけ元のまま残り、
> **動作に出ないので気づけない**（`shot-signedon.mjs` / `shot-signon.mjs` に注記）。

## 他クライアントの実測（tap-proxy）

`tap-proxy.mjs` は **IBM ACS 等の他クライアントと実機のやり取りを実測する中継タップ**。
仕様書に載っていない応答形式（Query Reply の能力申告・READ SCREEN EXTENDED(0x64) の応答）は
これで採った。ホストは形式違いを「機能チェック」としか言わないので、推測での総当たりは効かない。

```sh
TARGET=<実機IP> LOG=./tap.log node scripts/tap-proxy.mjs
# ACS のセッションを「このホストの IP / ポート 2323」に向けて操作する
```

5250 telnet だけ hex 記録し、ホストサーバーポート（449 / 8470-8476）は**記録せず中継のみ**
（資格情報が流れるため）。449 は特権ポートなので Linux では
`sudo sysctl -w net.ipv4.ip_unprivileged_port_start=440`（作業後は 1024 に戻す）。
解析時は telnet のエスケープを先に解除すること（`IAC EOR` を落とし `IAC IAC` → `0xFF`）。
**記録にはサインオンのパスワードが平文で残る。解析が済んだら削除すること。**
