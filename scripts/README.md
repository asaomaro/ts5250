# 実機 E2E / 診断スクリプト

`packages/tn5250` の `Session5250`（および MCP/WS）を実 IBM i（既定 pub400.com）に対して動かす E2E・診断スクリプト。

> **ここは実機に当てるものだけ。** ソフトウェアのビルドや成果物の検査は置かない
> （例: `crates/hllapi/tools/`）。**`build-*.mjs` は「IBM i 上にテスト用の資産を作る」**
> 意味であって、ソフトウェアをビルドするスクリプトではない——同じ `build-` でも別物。

## 実行方法

ビルド後、資格情報を環境変数で渡して実行する（`.env` は gitignore、パスワードはコミットしない）:

```sh
npm run build
node --env-file=.env scripts/<name>.mjs
```

必要な環境変数: `PUB400_USER` / `PUB400_PASSWORD`（自動サインオン）。任意: `PUB400_HOST`（既定 pub400.com）、
`PUB400_DEVNAME`、`PUB400_LIB`（既定 MARO1）。各スクリプトは成功で終了コード 0、失敗で 1。

## 検証に使う実機

| 機械 | 版数 | パスワードレベル | 備考 |
|---|---|---|---|
| **SR-OSAKA**（社内・LAN） | **IBM i 7.3**（`V7R3M0`） | **0**（DES 経路） | CCSID 5035 / SBCS は 5026 系。ライブラリ `ASAOLIB` |
| **PUB400**（インターネット・TLS） | **IBM i 7.5**（`V7R5M0`。2026-08-02 に実測） | **3**（SHA 経路。同日実測） | ライブラリ `MARO1`。1 往復 4〜7 秒。**特殊権限なし** |

> ⚠ **2026-08-01 より前の記録は SR-OSAKA を「IBM i 7.5」と書いているが誤り。**
> `.aidev/works/*` の research / walkthrough 等 15 件超が該当する（過去の記録なので
> 書き換えていない）。**7.3 で測った結果**として読むこと
> （経緯は `.aidev/works/20260801-realhost-version-and-pwdlevel/`）。

版数は**表示 1 つを信じず 2 経路で**確かめる。「SR-OSAKA も 7.5」は、おそらく誰も測らずに
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

`QSYS2.ENV_SYS_INFO` は SR-OSAKA に**無い**（`SQLCODE=-204`）ので、版数の確認には使えない。

> PUB400 は切断後もデバイスをしばらく保持するため、同名デバイスへの即再接続は
> `closed during negotiation` になりやすい。E2E 系はリトライごとにデバイス名を変える。

## 表示属性 E2E（DBCS・文字色・背景色・属性・インライン色）

`MARO1` に作った 2 組の DDS/RPGLE フィクスチャで、エミュレーターの属性デコードを検証する。

- **CLRTDSP/CLRTPGM** — フィールド単位の `COLOR`/`DSPATR` ＋ DBCS(日本語) 出力欄（表示）
- **INLTST/INLPGM** — インライン色制御（フィールドデータ中に属性バイト 0x20–0x3F を埋め込み、桁ごとに色切替）（表示）
- **INPTST/INPPGM** — フィールド型別の入力（数値/A(SBCS)/O(open)/J(pure DBCS)）＋DBCS 日本語のエコー往復（入力）

| スクリプト | 内容 |
|---|---|
| `build-attrtest.mjs` | `MARO1` に上記 3 組を作成・コンパイル（冪等）。ソースはコマンド行から `RUNSQL INSERT` で投入（IFS 不要）。 |
| `verify-command-template.mjs` | **CL コマンドのテンプレート**（`QCDRCMDD`）: 定義を引き、引用の要る値（`'`・空白・小文字・日本語）でコマンドを組み、実機で通して**読み戻して一致**を見る。許されない値を打つ前に弾くことも。 |
| `verify-attributes.mjs` | 表示検証: `CLRTPGM`（7 色・反転・下線・高輝度・桁区切り・点滅・DBCS）＋ `INLPGM`（埋め込み属性バイトの色切替）。**CCSID 1399**。 |
| `verify-input.mjs` | 入力検証（core）: `INPPGM` の 4 欄の型（numeric/SBCS/open/pure）＋ O/J のエコー往復。**CCSID 1399**。 |
| `verify-browser-dbcs.mjs` | 入力検証（実ブラウザ）: DBCS 往復＋**フィールド型ルール**（J は SBCS 不可・A は DBCS 不可・NUM は英字不可）を実 IME(CDP)で。 |
| `verify-browser-render.mjs` | 描画回帰（実ブラウザ）: 反転(背景色)セルの文字色≠背景色（文字が見える）／DBCS 全角の縦位置が同行テキストと揃う、を計算スタイル・幾何で検証。 |
| `verify-browser-select.mjs` | 矩形選択回帰（実ブラウザ）: カーソルが選択の始点に置かれ、マウス／キーボードで広げても動かない（ACS 相当）／ダブルクリックで語を選択（入力欄上の native 語選択を畳んで blur できるか）／カーソルが選択ハイライトより上に描かれる（jsdom は scoped CSS を解決しないため）。 |
| `verify-browser-paste.mjs` | 複数行ペースト回帰（実ブラウザ・12 項目）: `STRSQL` の SQL 入力エリア（独立した入力欄が縦に並ぶ）へ矩形の形のまま落ちる／書いた範囲だけ上書きし後ろの既存文字を残す（`123456` へ `789` → `789456`）／行またぎ欄（コマンド行）でも折返し先の同じ桁へ落ちる／帯の幅で折り返しあふれは次の帯行の同じ桁へ／挿入モードは後続を右へずらし入り切らねば「挿入する余地がありません」で何も書かない／ペースト後もカーソルが動かない。**SQL は実行しない**（Enter を押さない）ためホストは変更しない。 |
| `verify-browser-adjust.mjs` | ローカル編集キーと FFW の ADJUST 回帰（実ブラウザ・実機 SR-OSAKA・15 項目）: Field Exit（Ctrl+Enter）がカーソル以降を消して `CHECK(RZ)`＝ゼロ埋め／`CHECK(RB)`＝空白埋めで右寄せし次の欄へ進む／`CHECK(MF)` は桁を動かさない／符号付き数値欄は指定が無くても空白右寄せし符号桁を残す／Erase EOF（Ctrl+Delete）は消すだけで欄を出ない／Erase Input（Ctrl+Backspace）で全欄クリア。**最後に Enter を送り、ホストが受け取った値（`[000012]` / `[    12]`）まで確かめる**。**要 `ASAOLIB/ADJPGM`**（`build-adjtest-osaka.mjs`）。 |
| `verify-screen-size.mjs` | 画面サイズ検証: 24x80 / 27x132 × SBCS / DBCS の端末タイプと、`STRSEU`（*DS4 を持つ画面）が実際にワイドで来るか。DBCS はカラー端末（G02/C01）を掴めているかも見る。**要 `MARO1/QDDSSRC`**。 |
| `verify-printer.mjs` | プリンターセッション検証（core・実機）: `PrinterSession` で待ち受け → 表示セッションから自前スプールをそのプリンター OUTQ へ回し（`CHGJOB OUTQ`＋`DSPLIBL OUTPUT(*PRINT)`）→ ライターの用紙タイプ問い合わせ（`CPA3394`）に `I` で応答 → SCS を受信して "Library List" 帳票を桁揃えで展開できることを確認。**自分のデバイスにのみスプールを回す**ためホストを汚さない。 |
| `verify-printer-dbcs.mjs` | DBCS プリンター検証（core・実機・CCSID 1399）: `MARO1` のライブラリテキストを日本語に変えて `DSPLIBL` を印刷 → SCS 中の SO/SI 付き全角を受信し、帳票に日本語が桁揃えで載ることを確認（検証後にテキストを戻す）。**要 MARO1**。 |

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
- DBCS 入力欄は DDS データ型 `O`（DBCS-open）。フィクスチャは E2E 再利用のため MARO1 に残置している。

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
| `build-pcotest-osaka.mjs` | SR-OSAKA の `ASAOLIB` にテスト CL を作成（冪等）。`PCOTEST`＝データ域 `PCOCMD`/`PCOWAIT` を読んで `STRPCO`→`STRPCCMD` を実行し、前後で `PCOMARK` を書き換える。`PCO123`＝123 文字コマンド（行を跨ぐ配置の確認用）。**`ADDPFM` の `SRCTYPE(CLP)` が要る**（省くと `CPF0820` でコンパイルできない）。 |
| `verify-pcocmd-osaka.mjs` | 実機 E2E。`PAUSE(*YES)` / `PAUSE(*NO)` / 機能無効 / 許可リスト外の 4 ケースを別セッションで実行し、**ファイルが作られたか**で判定する（ホストは実行の有無を検証しないため、画面が進んだことは証拠にならない）。 |
| `research-strpco-osaka.mjs` / `-osaka2` / `-osaka3` | 調査用。`traceRecords` で受信レコードを hex 採取（1）、`STRPCO`/`STRPCCMD` の F4 プロンプトと QSYS の PC 系コマンド一覧（2）、テスト CL 経由の長いコマンド（3）。 |

```sh
node --env-file=.env scripts/build-pcotest-osaka.mjs    # 初回/再作成
node --env-file=.env scripts/verify-pcocmd-osaka.mjs    # E2E（28 アサーション）
```

注意:
- **同じジョブで `STRPCO` を 2 回実行すると `IWS4010`** になる。1 セッション 1 回に留める。
- `STRPCO` を先に実行しないと `STRPCCMD` は**何も送ってこない**（画面は変わらず CL は先へ進む）。
- 採取した生ログにはサインオン画面が写る。解析が済んだら削除する。

## FFW の ADJUST（右寄せ）とローカル編集キー（SR-OSAKA / ASAOLIB）

FFW の ADJUST 指定に基づく右寄せと、Field Exit / Erase EOF / Erase Input の検証。
**右寄せは端末の仕事**（ホストは整形しない）ことを実測で確かめてから実装した
（`.aidev/works/20260729-field-adjust-local-edit-keys/research.md`）。

| スクリプト | 内容 |
|---|---|
| `build-adjtest-osaka.mjs` | SR-OSAKA の `ASAOLIB` に `ADJDSPF`/`ADJPGM` を作成（冪等）。`CHECK(RZ)/(RB)/(MF)/(FE)/(ME)` を付けた英数字欄・素の欄・ゾーン数値欄・符号付き数値欄を並べ、`exfmt` の後に受信値を `[...]` で囲んで出力欄へ写す（**前後の空白が画面から読める**）。 |
| `research-adjust-osaka.mjs` | 調査用。`traceRecords` の生データストリームを **core を通さず独立にパース**して SF オーダーの FFW を並べる（検証対象の実装に依存させないため）。DDS の `CHECK(...)` がどのビットになるかを実測する。 |
| `research-adjust-roundtrip-osaka.mjs` | 調査用。同じ値を「左詰めのまま」と「右寄せ済み」で送り、ホストが受け取った値を突き合わせる。**英数字欄はホストが整形しない／数値欄は吸収される**ことがこれで分かる。 |
| `verify-browser-adjust.mjs` | 回帰 E2E（実ブラウザ＋実機・15 項目）。上の表を参照。 |
| `build-ffwtest-osaka.mjs` | SR-OSAKA の `ASAOLIB` に `FFWDSPF`/`FFWPGM` を作成（冪等）。DDS 35 桁のキーボード・シフト（`A`/`X`/`N`/`W`/`D`/`I`/`M`）と `CHECK(LC)` / `CHECK(ER)` を並べる。**1 件ずつ単独でコンパイルして通る指定を切り分けてから**本番の 1 レコードに束ねる（まとめて 1 回だけ試すと、どれが落としたか分からない）。 |
| `research-ffw-osaka.mjs` | 調査用。(A) `ADJPGM` で `CHECK(ME)` を空・`CHECK(MF)` を部分入力のまま Enter を送り、**ホストが検証するかどうか**を切り分ける。(B) `FFWPGM` の FFW を採る。 |
| `probe-signon-ffw.mjs` | 調査用。**サインオン画面に必須指定が無い**ことの確認（Enter の必須検証がサインオンを塞がない根拠）。 |
| `verify-browser-ffw.mjs` | 回帰 E2E（実ブラウザ＋実機・18 項目）。MONOCASE / `CHECK(LC)` / 英字専用（`X`）/ キーボード入力不可（`I`）/ AUTO_ENTER（`CHECK(ER)`）/ FER（`CHECK(FE)`）/ 必須検証（`CHECK(ME)`・`CHECK(MF)`）と **F3 は止めない**こと。**要 `ASAOLIB/ADJPGM` と `ASAOLIB/FFWPGM`**。 |

| `build-sgntest-osaka.mjs` | SR-OSAKA の `ASAOLIB` に `SGNDSPF`/`SGNPGM` を作成（冪等）。符号付き数値（`6S 0`）・ゾーン数値（`6 0`）・数値のみ文字（`6M`）・`DUP` キーワード付き欄を並べ、受信値を `[...]` で写す。Dup は `x'1C1C1C1C1C1C'` と突き合わせて `[ALLDUP]` を返す。 |
| `research-sign-osaka.mjs` | 調査用。**欄ごとに 1 つずつ**送って「どの形なら負値として届くか」を切り分ける。混ぜて送ると CPF5257 がどの欄由来か分からない。 |
| `verify-browser-sign.mjs` | 回帰 E2E（実ブラウザ＋実機・9 項目）。Field−（`[-12]`）／ Field+（`[34]`）／ Dup（`[ALLDUP]`）／ `DUP_ENABLE` でない欄では効かないこと。**要 `ASAOLIB/SGNPGM`**。 |
| `build-edttest-osaka.mjs` | SR-OSAKA の `ASAOLIB` に `EDTDSPF`/`EDTPGM` を作成（冪等）。`EDTCDE` / `EDTWRD` を**用途 B（入出力両用）**に書けるかを 1 件ずつ単独コンパイルで確かめる。 |
| `research-edtcde-osaka.mjs` | 調査用。編集コード／編集語つきの入力可能欄が、ワイヤ上**分解されるのか・編集文字を含んだまま 1 欄で来るのか**を実測する。 |
| `verify-browser-idle.mjs` | 回帰 E2E（実ブラウザ＋実機・11 項目）。**セッションの寿命**: 既定（永続）で 110 秒放置しても切れない（同時に**ハートビートの往復**も検証——pong を返さなければ 90 秒で半開きと判断される）／セッション設定 `idleTimeout: 1` で放置すると **60 秒で切れる**（早くは切らない）／同じ設定でも**打鍵し続ければ切れない**（在席の合図 `activity` が効いている。**AID キーは押さない**）／設定フォームの選択肢。掃除の間隔だけ `startIdleSweep(2000)` に縮める（判定は実装のまま）。**追加のホスト資産は不要**。 |
| `build-dttest-osaka.mjs` | SR-OSAKA の `ASAOLIB` に `DTMDSPF`/`DTMPGM` を作成（冪等）。**`EDTMSK`（編集マスク）つき入力欄**を 8 通り（`&` / 空白 / `&&/&&/&&` のマスク・`EDTCDE(Y)` 単独・`EDTWRD` の時刻・SSN・素の数値）並べる。**マスクの綴りを推測せず 1 件ずつ単独コンパイル**して通る書き方を実機に教えてもらう。DDS の定数は**英数字のみ**（日本語だと `INSERT` が長さ超過する。実測 155 > 153）。`DT_SKIP_PROBE=1` で単独コンパイルを省略できる。 |
| `research-edtmsk-osaka.mjs` | 調査用。`DTMPGM` の受信を **core を通さず独立にパース**して SF オーダーを並べ、**`EDTMSK` が欄を分解するか**を見る。**結論: 分解しない**（下記の注意）。 |
| `research-sysval-osaka.mjs` | 調査用。日付・時刻のシステム値の引き方を確かめる。**`QSYS2.SYSTEM_VALUE_INFO` は実在**し、値は `CURRENT_CHARACTER_VALUE` に入る（`QDATFMT=YMD` / `QDATSEP=/` / `QTIMSEP=:`）。候補を 1 つに絞らず順に試す形にしてある。 |
| `verify-browser-prompt.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**`F4` の導線**: 設定 OFF では出ない／ON でフォーカス中の欄の隣に出る／**ラベルはホストの凡例の語**（SR-OSAKA は化けたカタカナで来る）／押すと**ホストが実際にプロンプト画面を返す**（メインメニュー → `MAJOR メジャー・コマンド・グループ`）。画面設定メニューの操作（`.vsm-btn` → `.vsm-row` → `.seg button`）も通る。**追加のホスト資産は不要**。 |
| `probe-dtaq-longwait.mjs` | 調査用。**DTAQ の無限待ち接続が長時間アイドルを越えられるか**を実測する（既定 45 分）。`wait=-1` は read タイムアウトを無効にするので、相手が黙って消えても永久に待つ——`--minutes` で待ち時間を変えられる。**結論は下記の注意書き**。 |
| `verify-browser-watch.mjs` | 回帰 E2E（実ブラウザ＋実機・16 項目）。**データ待ち行列の常駐監視**: 監視開始 → 別接続からエントリを送ると**画面操作なしで履歴に現れる**／タブを離れているときに届くと**未読が付く**／開くと消える／**タブを閉じてもサーバー側の監視は残る**／リロード後に再接続しても**二重に監視を始めない**／**停止しても一覧に残り操作列が「開始」に変わる**／**止めている間に届いたものは消えず、再開すると受け取れる**。資格情報は `passwordEnv` で渡す（この環境では `SecretCrypto.fromEnv()` が使えず `passwordEnc` を復号できない）。**キューは自動で作って消す**（`ASAOLIB/DTQWATCH`）。⚠ 停止で行が消える前提だった旧版は `20260801-service-start-stop` で意味が変わっている。 |
| `verify-fresh-service-setup-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。**何も無い状態からサービス開始まで**: `.env` も `profiles.json` も無い**空のディレクトリ**でサーバーを起動し、master key が自動生成される／**ファイルが無くても編集できる**／画面から「保管場所: サーバー設定」でシステムを作れる（**パスワードは暗号化されて保存**）／その子のプリンターに**「サービスとして使う」の欄が出る**／**保存しただけで待ち受けが始まる**（再起動しない）／サービス一覧に「待ち受け中」で出る。⚠ この検証で「立ち上げに失敗しても実体が残らず、理由がログにしか無い」不具合が見つかった。⚠ **セレクタは見出しの完全一致で指す**——`hasText` の正規表現は空白を正規化しないので、折り返した見出しには `\s*` が要る（実際に踏んだ）。 |
| `verify-services-pane-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。**サービス一覧のペイン＋定義変更の反映**: 定義が一覧に出る／**一度も開いていない定義は「未起動」**／サービス ☐ は「対話型」と分かる／**PDF 保存先のパスは画面に出ない**（有無だけ）／**タブを開いても接続が増えない**（`sessions.size === 0` で確認）／**一覧から起動できる**（起動応答 `I902`・常駐として立つ）／停止 → 再開／ルートが `editable` を返す／**保存でサービスが再起動なしに立ち上がる**／**動いているものは保存で切れず「要再起動」が出る**／開始し直すと消える／サービス ☐ と削除で止まって実体が消える。設定は一時ファイルで、実機の `profiles.json` には触らない。 |
| `verify-dtaq-webhook-osaka.mjs` | 回帰 E2E（実機・14 項目）。**待ち行列サービスの Webhook 転送**: 実キューのエントリが**実際の HTTP で届く**（本文・キュー名・秘密のヘッダー・本文の署名・配送 id）／**受け手を落としても監視は止まらない**（止まるとホスト側のキューが溢れる）／諦めた分が**「未達」として一覧に出る**／受け手が戻れば届く／**4xx は再試行しない**。受け口はスクリプト内に立て、待ち行列（`ASAOLIB/DTQHOOK`）は**自動で作って消す**。⚠ この検証で「未達の数が次の到着まで古いまま」の不具合が見つかった（単体テストでは現れない）。 |
| `verify-service-auth-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・**認証あり**・16 項目）。**サービスの認可**: 管理者は一覧から起動できる／**一般ユーザーは見えるが操作ボタンが出ない**／API を直に叩いてもパスも警告も返らず、設定の一覧は 0 件のまま／**WS へ直接送っても断られ、サーバー側の状態が変わらない**（画面が隠しているだけではないことの確認）。検証用の資格情報は**メモリにだけ置く**使い捨てで、実機のものとは無関係。⚠ この検証で `printer-stop` の拒否が返らずプロセスが落ちる不具合が見つかった（認証オフでは絶対に踏まない）。 |
| `verify-view-cascade-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・12 項目）。**「外観」と「表示」／表示設定の 2 段カスケード**: **移行しても画面の地色が変わらない**（テーマのブロックを「差分を当てる」形から自己完結へ書き換え、選択子から `:root` を外したので、特定度が (0,2,0)→(0,1,0) へ下がる。優先関係が保たれているかは実画素でしか見られない。`AS400_BASELINE_GRID` に前の版で測った地色を渡すと機械的に突き合わせる）／ボタンが `外観`・`⚙ 表示`／**セッション個別のテーマがペインの中だけに効く**（画面 `rgb(247,248,244)`→`rgb(5,13,9)` に対しタブ帯とヘッダーは不変）／既定に戻すと元へ戻る。⚙ 表示のボタンは**ページの中で探して押す**——Playwright の `hasText` はテンプレート由来の改行が入るボタン（`既定に従う（…）`）で当たらないことがある（実際に踏んだ）。**ヘッダーのボタンの高さが 5 つとも揃う**／**「既定に従う」の選択肢が無く既定の値にだけ印が付く**／**スプールでも `⚙ 表示` が出て、効く項目（リンク化・フォント）だけが並ぶ**も見る（`20260802-view-menu-refine`）。 |
| `verify-tabs-own-system-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。**異なるシステムのタブを並べて同時に見る**: A の SQL と B の SQL が**別のタブ**として並ぶ／**それぞれの要求が自分のシステムへ飛ぶ**（Playwright の `request` で**本物の HTTP の body を覗いて**確かめる。ここが本題）／2 システム開いているときだけタブに**システム名**が出て**色帯**が付く／システムを選び直しても**タブが 1 枚も消えない**／**ヘッダーが常に見ているタブのシステムを映す**（タブを押すだけで変わる。`20260802-header-follows-tab`）。システム設定は 2 つとも同じホストを指し、**オブジェクトは何も作らない**（`SYSIBM.SYSDUMMY1` の SELECT を 2 回）。⚠ 2 システム分のペインが**同時にマウントされている**ので、操作は `.pane-slot:not([data-hidden])` で**見えているほうに絞る**——`.first()` だと隠れているペインを掴んで固まる（実際に踏んだ）。⚠ システム選択画面に居るときパンくずの第 1 段は `disabled`。押そうとすると有効になるまで待ち続ける。 |
| `verify-pane-state-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・19 項目）。**開いたタブは閉じるまで生かす**: 打った内容がタブの行き来／メニューへの寄り道／**システムの選び直し**をまたいで残る／一度も開いていないタブはマウントされていない／その間ずっと **5250 の画面の大きさが変わらない**（ペインを包み紙で括り `<main>` を 1 つにまとめたので、高さの連鎖 `main`→`.ws-root`→`.group`→ペイン が切れると縮む。jsdom では検出できない）。2 つ目のシステムは切替の相手に置くだけで**接続しない**。**分割・最大化・タブ移動**も通す（`20260802-keep-pane-state-move`）——最大化で幅が 695→1400px になり、解除で元の比率へ戻り、その間ずっと打った内容が残ること。⚠ タブの D&D は `dragAndDrop` ではなく **`mouse.down`→`move`→`up`** で行う（HTML5 の DnD はマウスを動かさないと `dragover` が出ず、落とし場所の判定が走らない）。⚠ システムを選び直した直後は**メニューに居る**（従来どおり）ので、画面の寸法は「ワークスペース」へ戻してから測ること——隠れている間は 0x0 で当たり前（実際に踏んだ）。 |
| `verify-logpanel-stack-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**ログパネルが画面の中の重ねものより上に来るか**。`.grid` と `.logpanel` の間にスタッキングコンテキストが無いこと（あれば z-index の大小は無意味）／パネルの z-index が 10 ／`.grid` が `z-index:auto` のまま（中の重ねものがこの土俵へ出る前提）／**z-index 7 の板を重ねても `elementFromPoint` がパネルを返す**。option の▾を出すには Opt 欄のある画面まで運転が要るので、**同じ高さの板を代役**にしている。⚠ 直す前（パネル 5）に戻すと 3 項目が落ちることを確認済み。 |
| `verify-cursor-align-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・7 項目）。**カーソルと文字が同じ桁・同じ行に載るか**を実画素で測る。保護領域をクリックした桁へカーソルが行く／カーソルの矩形が**その桁の文字の矩形**と重なる／`.grid` の content box から計算した位置と一致する。**jsdom は scoped CSS を計算しない**ので、ずれそのものはここでしか測れない（単体テスト `grid-overlay-offset.test.ts` が見ているのは *ずれを生む書き方*）。⚠ 縦は上端ではなく**中心**で比べる——`Range` が返すのは字の inline box で、行box とは高さが違う（実測 32.5px vs 37.0px）。装置名は指定せずホストに採らせ、画面を読むだけでオブジェクトは作らない。 |
| `verify-service-ui-osaka.mjs` | 回帰 E2E（実ブラウザ＋実機・17 項目）。**サービスの操作 UI**: 設定フォームが `サービスとして使う` ✅ と `自動で待ち受け開始` ☐ と PDF 保存先を**読み込んで開く** → **名前だけ直して保存しても出力設定が消えない**（画面に欄が無い `pdfFontName` も残る）→ `自動で待ち受け開始 ☐` の定義を開くと**停止中**で「待ち受け中…」と嘘を書かない → 開始ボタンで**実機に繋がる（起動応答 `I902`）** → 停止 → **再開できる**（＝停止で本当に装置を手放している）。設定は一時ファイルに書き、**実機の `profiles.json` には触らない**。装置は借りるだけ（既定 `PRT_ASAO`）。 |
| `research-sql-exec-osaka.mjs` | 調査用。**結果を返さない SQL 文（DML / DDL）が既存の要求で実行できるか**を実測する。`prepareAndDescribe`(0x1803) → `execute`(0x1805) を**マーカーデータ無し**で送り、CREATE / INSERT / UPDATE / DELETE / DROP・構文誤り・存在しない表・SELECT の経路違い・実ライブラリー（SQL 命名とシステム命名）を 1 件ずつ通す。**表は `QTEMP` に作る**（接続ごとに消えるので後片付けが要らない）。⚠ 成否は **SQLCODE** で見る——`reply.rcClass` は `Reply` に無い欄で、参照すると常に失敗扱いになる（この検証で実際に踏んだ）。 |
| `verify-browser-sql-exec.mjs` | 回帰 E2E（実ブラウザ＋実機・13 項目）。**SQL 画面からの更新**: CREATE（**「実行しました」＋実ライブラリーでは警告 `SQLCODE=7905`**）→ INSERT / UPDATE / DELETE（**「N 行に影響しました」**）→ SELECT で**ホストの表が実際に変わったこと**を確認 → 存在しない表は `SQLCODE=-204` で失敗 → `?` 付きは実行前に断る → `;` 区切りの混在でタブが 2 つ（非クエリと表）→ DROP。表は `ASAOLIB/SQLEXECB` を**自動で作って消す**。資格情報は `passwordEnv` で渡す。 |
| `research-sql-cancel-osaka.mjs` | 調査用。**結果セットの早期打ち切り**を実測する。上限 1/50/99/100/101/200/250 で打ち切り、**打ち切った直後に同じ接続で SELECT / UPDATE が通るか**・fetch の**往復回数と受信バイト数**・ブロッキング係数を絞った効果・「続きがあるか」を上限＋1 行で判定できるかを並べる。**結論: 打ち切りはホストに副作用を残さない**（20,000 行で全件 201 往復 / 1,191,336 バイト / 2,072ms → 上限 200 で 2 往復 / 11,912 バイト / 44ms）。表は `QTEMP` に作るので後片付け不要。 |
| `verify-sql-limit-osaka.mjs` | 回帰（実機・8 項目）。**取得量の上限が MCP と REST の両方で効いているか**。20,000 行の表に対し `host_sql`（実際の登録コードを通してハンドラを呼ぶ）が上限 200 で 200 行＋`truncated: true` を返し、**接続込み 177ms** で終わること／**上限ちょうどでは `truncated: false`**（嘘をつかない）／REST 単発経路（`pageSize` 無し）も同じ。表は `ASAOLIB/SQLLIMIT` を自動で作って消す。資格情報は `passwordEnv` で渡す。 |
| `diag-qsh-osaka.mjs` | 調査用。**QSH（Qshell）が固まる原因**を実測する。メインメニューで `QSH` を実行し、届いたレコードを**実装と独立に**並べて「どのコマンドで捨てているか」を見る。**結論: `ESC 0x03`（SAVE PARTIAL SCREEN・パラメータ 5 バイト・opcode PUT/GET）に応答していなかった**。装置名は実機に登録済みの名前（`WEBSF0`〜）を順に試し、前ジョブの回復画面は `90` で越える。 |
| `verify-browser-qsh.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**QSH が使えること**: 接続 → メインメニュー → `QSH` で**画面が出る**（従来はここで待機のまま固まった）→ `ls -l /` の出力が読める → 続けて実行すると出力が流れる → F3 で抜ける。装置名は `AS01` を先頭に空いているものを探す。⚠ 画面の凡例「F3= 終了」と鍵盤ボタンは別物——**ボタンを指定して押す**（`getByText("F3")` は画面の文字に当たる）。 |
| `census-5250-commands-osaka.mjs` | 調査用。**実機の画面が実際に使う 5250 コマンドを数える**。読み取り専用の画面 11 件（`STRSQL`/`DSPMSG`/`WRKACTJOB`/`WRKSYSSTS`/`DSPJOBLOG`/`WRKSPLF`/`DSPLIBL`/`WRKOBJ`/`STRPDM`/`GO CMDIFS`/`QSH`）を巡り、各画面で PageDown/PageUp も送る。**正確さの度合いを分けて出す**——レコード先頭（正確）／実装の未知判定（決定的）／全走査（参考。WTD 内の 0x04 も拾う）。結論は `.aidev/backlog/datastream-commands.md`。 |

```sh
node --env-file=.env scripts/build-adjtest-osaka.mjs      # 初回/再作成
node --env-file=.env scripts/verify-browser-adjust.mjs    # E2E（15 項目）
node --env-file=.env scripts/build-ffwtest-osaka.mjs      # 初回/再作成
node --env-file=.env scripts/verify-browser-ffw.mjs       # E2E（18 項目）
node --env-file=.env scripts/build-sgntest-osaka.mjs      # 初回/再作成
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
  エントリが失われる**（2026-07-30・SR-OSAKA で A/B 実測。`probe-dtaq-longwait.mjs --minutes 45`）。
  - **keepalive 無し**: 45 分アイドル後に送ったエントリは**キューから消えたのに `read` は返らない**
    ＝接続は死んでいるのにこちらは気づかず、**ホストが死んだソケットへ払い出して捨てた**
  - **keepalive 有り**（`setKeepAlive(true, 60_000)`。現在の実装）: **45 分を越えて受信できた**
  - `wait < 0` は read タイムアウトを無効にするので、**こちらから死を知る手はキープアライブだけ**。
    常駐監視はそれでも切れたら指数バックオフで張り直す。
- **監視は「同じ設定で 2 本」を作らせない。判定はサーバー側**（`WatchRegistry.start`）。
  画面側だけで見ると**リロード直後は一覧が届いておらず**すり抜ける（実機 E2E で 2 本になった）。
  監視は消費するので、2 本掛かると 1 本ぶんのエントリを取り合って両方が欠ける。
- **`EDTMSK` は欄を分解しない**（2026-07-29・SR-OSAKA・8 通りの DDS で実測）。
  `EDTCDE(Y)` / `EDTWRD` に `EDTMSK` を足しても、**どの綴りでも 1 欄で来て編集文字は欄の中の値に入る**
  （`value=" 0/00/00"`）。マスクは 3 通りとも `CRTDSPF` が通るので、**「書けるか」では
  分解の有無を判別できない**。`.aidev/backlog/input-assist.md` の datepicker が
  これで「作らない」に決着した（判定材料が無い）。**再調査しないこと。**
- **日付・時刻のシステム値**は `QSYS2.SYSTEM_VALUE_INFO` から引ける
  （`QDATFMT` / `QDATSEP` / `QTIMSEP`。値は `CURRENT_CHARACTER_VALUE`）。
- **セッションの寿命は実測で確かめた**（2026-07-29・SR-OSAKA）: 既定（永続）は 110 秒放置でも切れず、
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

## IFS ファイルブラウザ（SR-OSAKA / /home/ASAO）

| スクリプト | 内容 |
|---|---|
| `verify-browser-ifs-osaka.mjs` | IFS ペインの操作 E2E（実ブラウザ・実機 SR-OSAKA・18 項目）。`/home/ASAO/TEST` を作って、**画面の操作だけ**でフォルダ作成／ファイルのアップロード・プレビュー・編集保存・ダウンロード・改名・削除／**フォルダごとのアップロード**（入れ子・日本語名）／zip 一括ダウンロード／フォルダの改名・中身ごと削除まで通す。**API は検証と後始末にしか使わない**（下回りだけ通っても「画面から行えるか」の答えにならない）。 |
| `verify-ifs-limits-osaka.mjs` | 上限表示・プレビュー競合・先回り判定の実機検証（15 項目。PR #231）。`/home/asao/test` を作り、`GET /limits`／413 に上限が載ること／**上限超過で read を発行しないこと**／ヌルバイト入りの案内／連続選択で最後の 1 つが残ること／zip の上限文言を見る。 |

要点（`verify-ifs-limits-osaka.mjs`）:

- **上限を CLI 引数で下げて検証する**（`ifsReadMaxBytes: 4096` / `ifsZipMaxBytes: 1024`）。
  既定 5MiB の超過を作るには 5MB 超を 100KB/s のホストへ置く必要があり、検証のたびには払えない。
  先回りの分岐は「`sizeHint` > 上限」で決まるので、上限を下げれば**同じ経路**を通る。
  ついでに CLI 引数が `/limits` に反映されることも確かめられる。
- **「read を発行しない」は画面を通さないと確かめられない。** `page.on("request")` で
  `/api/host/ifs/read` を数える。API だけ叩いても答えにならない。
- **一覧に出る名前は `ASAO`（大文字）。** IFS は解決時に大小を区別しないので API は
  `/home/asao` でも通るが、画面の行を掴むには格納されている綴りが要る。
- **固定待ちにしない。** 実機は 1 往復が数秒（書き込みで 4〜8 秒を実測）で、`sleep(2500)` だと
  「まだ来ていない」を「壊れている」と読み違える。`.preview .path` が変わるまで待つ。
- **本文は `textarea` の value。** `innerText` には出ないので `inputValue()` で取る。

要点（`verify-browser-ifs-osaka.mjs`）:

- **保存は元より短い内容で試す。** 長くする編集だと通ってしまう——OPEN を「開くだけ」で書くと
  先頭からの上書きになり、41 バイトのファイルに 19 バイト保存して末尾 22 バイトが旧内容のまま残る
  （実機で踏んだ。`FILE_DUPLICATE.createOrReplace` で修正済み）。ホストの `list` が返すサイズまで見る。
- **「保存しました」を待ってから測る。** クリック直後は busy が立つ前なので、
  待たずに一覧を読むと書き込み前のサイズを掴む。
- **フォルダのアップロードは `input[webkitdirectory]` に*ディレクトリのパス*を渡す**（Playwright ≥1.42）。
  ファイル用の入力とは別物なので、セレクタは `:not([webkitdirectory])` で書き分ける。

```sh
node --env-file=.env scripts/verify-browser-ifs-osaka.mjs
node --env-file=.env scripts/verify-ifs-limits-osaka.mjs
```

`verify-browser-ifs.mjs` は同じペインの pub400（`/home/MARO/ifsdemo`）版。プレビュー（画像・PDF）と
`/QSYS.LIB` の「先頭 N 件まで」はこちらが見ている。

## その他

`verify-autosignon` / `verify-signon` / `verify-mcp` / `verify-ws` / `verify-browser` / `verify-dbcs-tls` /
`verify-gui-enhanced`（各機能の実機検証）、`capture-*`（トレース fixture 採取）、
`diag-*`（signon/PDM 診断・`diag-window-fkey` は DDS 窓で無効キーを押したときのホスト応答）、
`dump-screen`（トレースをオフライン再生）も同じ実行規約に従う。

### 画面採取・実測の族（SR-OSAKA / ASAOLIB）

窓検出・GUI 拡張・F キー凡例・罫線まわりの調査で使った一群。**1 本ずつ表にすると
上の重い表が埋もれる**ので族でまとめる。いずれも実行規約は同じで、接続先は
`AS400_HOST`（既定値なし。未設定なら落ちる）。

| 族 | 本数 | 中身 |
|---|---|---|
| `shot-*` | 15 | 画面・UI の採取。ブラウザ経由（`shot-crt` / `shot-buttons-osaka` / `shot-font-osaka` / `shot-viewsettings-osaka` / `shot-keycycle` / `shot-window-fkey` ほか）と MCP の `get_screen_html` 経由（`shot-signon-osaka` / `shot-signedon-osaka` / `shot-asaolib-screens` / `shot-spool-html-osaka` ほか） |
| `build-*-osaka` | 3 | `ASAOLIB` に DDS/RPGLE のフィクスチャを作る（`empsfl`＝サブファイル / `ext`＝拡張5250 / `feat`＝各種機能） |
| `probe-*` | 3 | 単発の実測。`probe-ccsid-osaka`（SBCS が 939 系か 5026 系か）/ `probe-window-signal`（窓の受信データ上の徴候）/ `probe-asaolib-refs`（`DSPPGMREF` で表示装置ファイル参照を洗う） |
| `check-*` | 3 | 不変条件の確認。`check-html-determinism`（同じ画面から常に同じ HTML か）/ `check-menu-exclusive` / `check-persist` |
| `diff-*` | 2 | 実機とこちらの出力の突き合わせ。`diff-gridlines`（罫線）/ `diff-webui-vs-host`（web-ui とホスト画面） |
| 単発 | 3 | `list-asaolib`（ライブラリの中身一覧）/ `research-ext-gui`（拡張5250 の GUI 要素調査）/ `verify-spool-html`（スプール HTML の検証） |

`research-lob-threshold-osaka.mjs` — **LOB フィールドしきい値（CP `0x3822`）の実測**。
`ASAOLIB.LOBTHR`（CLOB / 大きい CLOB / BLOB / DBCLOB）を作り直し、しきい値 0 と 64KB で
列の型コード・行の並び・往復数・受信バイト数を比べる。しきい値以下の LOB は
ロケーターではなく**行データに載って**届き、型コードが `964 CLOB_LOCATOR` → `408 CLOB` に変わる。
**DBCLOB の長さ接頭辞は文字数**（CLOB/BLOB はバイト数）なので、
**全角を含む値でしか取り違えを検出できない**（`20260801-lob-threshold-realhost`）。

`research-lob-free-osaka.mjs` — **ロケーターの解放（要求 `0x1819`）の実測**。
解放が効くか／二重解放の戻りコード／接続を閉じた後／番号の配り直し、の 4 点を測る。
**接続を閉じればロケーターは消え、次の接続では同じ番号が配り直される**ので、
単発接続では明示的な解放は要らない。**二重解放は `2 / -816`** で、
原典のコメントが挙げる `7 / -401` とは違った（`20260801-lob-locator-free`）。

`research-dbclob-locator-osaka.mjs` — **ロケーター経由の LOB の長さの単位と復号の実測**。
`DBCLOB(CCSID 1200)` と混在 `CLOB` を同じ値で作り、`lobData` の申告長と実際の本体を突き合わせる。
**2 バイト/文字の CCSID でだけ申告長が文字数**（混在・SBCS はバイト数）。
⚠ **SBCS だけで試すと一致してしまい取り違えに気づけない**（`20260801-dbclob-locator-decode`）。

`research-lob-multi-segment-osaka.mjs` — **64KB を超える LOB の分割受信の実測**。
`0x1816` の往復を生で覗き、`lobStartOffset` / `lobRequestedSize` / 申告長 / 総長の
**単位がすべて「文字」**であることを確かめる。表は倍々に伸ばして作る
（SQL 文の長さ制限に当たらない）。**finally で必ず消す。**

`verify-lob-multi-segment-osaka.mjs` — 上が見つけた不具合が**直ったこと**の確認。
`20260802-lob-multi-segment` で直す前は、2 バイト CCSID の 2 周目で
`lobStartOffset` にバイト数を入れていたため**位置が 2 倍に飛び、
524,288 バイトの DBCLOB から 65,535 文字が丸ごと抜けていた**。

> ⚠ **穴が空いた値に `too-large` が付く**のが最悪だった。あの印は「先頭から順に取れて
> 末尾で切れた」と読ませるので、**中抜けに気づけない**。検査は件数ではなく
> **先頭からの連続性**で行うこと（`contiguous()`）。
>
> ⚠ **上限（`lobMaxBytes`）も 2 倍に膨らんでいた**——`maxBytes=200,000` に対し
> 262,140 バイトを保持していた。メモリを掴まないための上限が効いていなかった。
>
> ⚠ 分割経路は **`lobMaxBytes` を明示的に上げないと通らない**
> （`SEGMENT_UNITS`=65,535 に対し既定の上限が 65,536）。だから PR #248 / #251 の
> 実機確認をすり抜けた。**既定値で測っても分割は起きない。**

`research-lob-big-dbcs-blob-osaka.mjs` / `verify-lob-big-dbcs-blob-osaka.mjs`
— **純 DBCS（CCSID 300）と BLOB の 64KB 超**（`20260802-lob-big-dbcs-blob`）。
上の 2 本は UTF-16 と混在 CLOB しか測っておらず、残る 2 系統は
「`isTwoByteCcsid` が同じ枝だから同じはず」という**判断で押されていた**。実測で閉じた（18/18）。

> ⚠ **実機の BLOB は CCSID `65535`（0xFFFF＝「変換しない」）で来る。`0` ではない。**
> `decodeLobBytes` は `0` しか見ておらず、**`catch` に落ちて偶然バイト列を返していた**
> ——65535 に codec を足した瞬間に BLOB が文字列へ化ける形だった。`isBinaryCcsid` に集約済み。
>
> ⚠ **純 DBCS には直接の変換が無い**（ジョブの 5035 → 300 は `-332/57017`）。
> `CAST(CAST(… AS DBCLOB CCSID 1200) AS DBCLOB CCSID 300)` と**1200 を経由する**。
> ただし**連結（`P || P`）は同じ CCSID どうしなので変換が要らない**——
> 種だけ二段キャストで作れば、あとは倍々に伸ばせる（15 回で 524,288 バイト）。

`research-sql-table-render-osaka.mjs` / `verify-sql-table-virtualize-osaka.mjs`
— **SQL 結果表の描画コスト**（`20260802-sql-table-virtualize`）。実ブラウザ（Playwright）で
アプリを立ち上げ、40 列の `SELECT` を実機から取って**応答を読み終えてから
レイアウトが確定するまで**を測る。表は作らない（`QSYS2.SYSCOLUMNS` から行を取る）。

> ⚠ **`npm run build` では web-ui の `dist` は作られない**（root の `build` は
> `tsc -b` ＋ 型検査だけ）。**`npm run build -w @ts5250/web-ui` が要る**。
> 忘れると古いバンドルを測ることになり、**変更が効いていないのに数字だけ出る**
> （実際にこれで 1 度、計測をまるごと無駄にした）。
>
> ⚠ **計測器は前後で同じものを使う。** 基準線は「全行が出揃った時刻」、
> 仮想化後は「行が 1 つでも見えた時刻」——**待ち方が違うと数字が比べられない**。
> 窓の確定まで待つと rAF 2 枚ぶん余計に乗る（別々に出している）。
>
> ⚠ 応答本文は**自分で読み切ってから時刻を刻む**。`res.clone().text()` を `.then` で
> 待つと、アプリが描き終えたあとに解決して **200 行が「0 ms」**になった。

`research-device-busy-osaka.mjs` — **装置名が使用中のときにホストが返すもの**
（`20260802-device-busy-record`）。同じ装置名で 2 本開き、受信レコードを生で見る。
**装置は作らない**（自分の設定にある `AS01` を 2 本開くだけ）。

> ⚠ **接続条件を設定と揃えないと症状が出ない。** 既定（CCSID 37 / 24x80）で繋ぐと
> **起動応答より前**の交渉段階で切られ、レコードが 1 つも届かない
> ——「再現しない」と結論しかけた。設定どおり（**CCSID 5026 / 27x132**）にすると、
> ホストが `8902 Device not available.` の起動応答を返すところまで到達する。
>
> ⚠ 実機の `AS01` は**他の接続が掴んでいることがある**。1 本目が開けないときはそれを疑う。

`research-msgw-osaka.mjs` — **MSGW（スプールがライターの問い合わせで止まった状態）の実測**。
既存の仮想プリンター装置を借り、用紙タイプをずらしたスプールで `CPA3394` を誘発して
`retrieveMessage` / `answerMessage` を通す。**ライターは必ず止め、スプールは消す。装置は作らない・消さない。**
装置名は `AS400_PRTDEV`（既定 `PRT_ASAO`）。

> ⚠ **SR-OSAKA はプリンターの自動構成を許さない**（`8940`。`QAUTOVRT=200` でも）。
> `CRTDEVPRT DEVCLS(*VRT)` で自作しても `VRYCFG` が `CPF2640`、セッションは `8903`。
> **既存装置を借りるしかない**。
> 上書きは **`OVRPRTF FILE(QPRTLIBL)`**——`DSPLIBL OUTPUT(*PRINT)` が作るスプールの名前。
> 間違えると用紙タイプが揃ったまま印刷され、MSGW にならない（`20260801-msgw-realhost-verify`）。

> 📌 **接続先をハードコードしない。** 出力に焼く説明文（HTML のメタ・画像の注記）も
> `AS400_HOST` から組む——固定文字列にすると、別ホストへ繋いだのに説明文だけ元のまま残り、
> **動作に出ないので気づけない**（`shot-signedon-osaka.mjs` / `shot-signon-osaka.mjs` に注記）。

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

`research-ifs-dataccsid-osaka.mjs` — **IFS の新規ファイルに付く CCSID タグの実測**。
`dataCcsid` を指定しない／`1208`／`1399`／既存の上書き、の 4 条件を比べる。
**指定は採用される**が、**既存ファイルのタグは上書きでも変わらない**。
既定タグは機械ごとに違う（SR-OSAKA は `1041` / PUB400 は `850`）ので、
**中身が UTF-8 でも嘘のタグが付く**（`20260801-ifs-write-dataccsid`）。
置いたファイルは `finally` で消す。

`research-call-program-osaka.mjs` — **プログラム呼び出し（`host_call_program`）の正常系**。
`QUSROBJD`（`OBJD0100`）と `QSYRUSRI`（`USRI0100`）を正しいパラメータ列で呼び、
**返った中身を外部の事実と突き合わせる**（「エラーが出ない」だけでは間違った位置を
読んでいても気づけない）。出力が**要求順**に返り、入力の位置が `null` になることも見る。
文字列は **EBCDIC・右空白詰めの固定長**、長さは 4 バイト、
**エラーコード構造の先頭 4 バイトは 0**（非 0 にするとメッセージが出なくなる）。
副作用なし（`20260801-call-program-realhost`）。

`research-pure-dbcs-lob-osaka.mjs` — **純 DBCS の DBCLOB（CCSID 300）の実測**。
ロケーター経由とインラインの両方で、中身・`byteLength`・申告長（**文字数**）を確かめる。

> ⚠ **純 DBCS の列はジョブの CCSID から直接作れない**（`-332/57017`＝変換が無い）。
> **1200 を経由する二段キャスト**なら通る:
> `CAST(CAST('日本語' AS DBCLOB(1K) CCSID 1200) AS DBCLOB(1K) CCSID 300)`。
> `16684` はこの実機では 1200 経由でも通らなかった（`20260801-pure-dbcs-dbclob`）。

`verify-printer-residency-osaka.mjs` — **プリンター常駐の通し確認**。
出力設定つきで開く → **購読を外す（ブラウザを閉じた状態）** → スプールを流す →
**帳票を受信して PDF が保存される**ところまで見る。

> ⚠ **ライターは自動では上がらない**——プリンターセッションを繋いだだけでは
> スプールが `READY` のまま溜まる。`STRPRTWTR` が要る。
> **前の実行の残骸が装置を掴む**と何も届かないので、開始時に `ENDWTR` ＋ `CLROUTQ` する
> （＝**そのキューのスプールを消す**。共有装置では注意）。
> 用紙タイプはずらさない（ずらすと MSGW で止まる。それを狙うのは `research-msgw-osaka.mjs`）。

`verify-printer-report-history-osaka.mjs` — **閉じている間に届いた帳票の配り直し**。
ブラウザで開く → **WS を切る** → スプールを流す → **開き直して読める**ところまで見る。

> **`WsConnection` を通す**のがこのスクリプトの要点。ほかのプリンター系は
> `SessionManager` を直接叩くが、`20260802-printer-report-history` で壊れていたのは
> **電文の層**（サーバーは `printer-opened.reports` に載せていたのに web-ui が捨てていた）。
> 受け手側は vitest（`printer-report-restore.test.ts`）で、電文側をここで測る。
>
> 見るのは件数だけでなく**受信時刻**——`閉じた < 受信 < 開き直し` が成り立つかを確かめる。
> 開いた時刻で押していると、この不等式が両側とも崩れる。
> 資格情報は `passwordEnv` で env のまま渡し、設定オブジェクトに平文を置かない。

## SQL 画面（SELECT 以外）の検証用資産（SR-OSAKA / ASAOLIB）

| スクリプト | 内容 |
|---|---|
| `build-sqldemo-osaka.mjs` | `ASAOLIB` に `SQLDEMO*` 一式を作って**残す**（表・ビュー・索引・トリガー・手続き 3 種・関数）。手続きは **OUT パラメーター**・**結果セット 1 個**・**結果セット 2 個**の 3 通りで、SQL 画面の見え方を人が確かめるためのもの。**DDL はこのスクリプトが持ち物**で、SQL 画面へそのまま貼っても通る形で書いてある（複合文をコピーして実行できる）。毎回作り直す（先に DROP する）。 |
| `verify-browser-sql-exec.mjs` | 実ブラウザで SQL 画面を操作する回帰（25 項目）。**自前の `SQLEXEC*` を作って最後に消す**——`DROP` が効くこと自体が検証対象なので、残す資産（上の `SQLDEMO*`）とは名前を分けてある。 |

```sh
node --env-file=.env scripts/build-sqldemo-osaka.mjs    # 検証用資産を作る（残る）
AS400_PASSWORD=... node scripts/verify-browser-sql-exec.mjs
```

作ったあと SQL 画面で試すもの:

```sql
SELECT * FROM ASAOLIB.SQLDEMO ORDER BY ID;
CALL ASAOLIB.SQLDEMOP(1, 1.50, ?);   -- 出力パラメーター
CALL ASAOLIB.SQLDEMORS();            -- 結果セット 1 個
CALL ASAOLIB.SQLDEMORS2();           -- 結果セット 2 個（1 個目だけ出る）
CALL ASAOLIB.SQLDEMOPICK();          -- その 2 個目（ロケーター経由の雛形）
SELECT ID, ASAOLIB.SQLDEMOF(ID) FROM ASAOLIB.SQLDEMO ORDER BY ID;
```

> ⚠ **アプリを止めてから実行する。** 起動したままだとプールの接続が表を掴んでいて
> `DROP` が 20 秒で時間切れになり、そこで接続が使えなくなる（スクリプトは理由を出して止まる）。

### 2 個目以降の結果セット

ホストサーバー経由では、手続きが返す結果セットは **1 個目しか開けない**。2 個目を開こうとすると
`SQLCODE -517`（選択ステートメントではない）で断られる。SR-OSAKA で 10 通り試して確認した
——カーソル名を変える／取り切る前に開く／閉じてから開き直す／手続き側の名前（`C1`・`C2`）で開く／
`describe` を挟む／`openDescribeFetch`／文名を分けて 2 度 `execute`／実行し直す／
文の種別 0〜6 の総当たり／ORS を全ビット。**どれも 1 個目が返る。**

SQL の側には道がある（`ASSOCIATE RESULT SET LOCATORS`）。ただし**読んだ行をクライアントへ
返すには列の形を知った器が要る**ので汎用にはできない。`SQLDEMOPICK` がその雛形で、
`SQLDEMORS2` の 2 個目を一時表へ写して `WITH RETURN` で返している。

## SQL 実行計画（Visual Explain 相当）

`20260802-sql-visual-explain`。**自ジョブの DB モニター**（`STRDBMON JOB(*)`）で計画を採る。
**特権は要らない**——PUB400 の特殊権限なしユーザーで通ることを実測した。
一方**プランキャッシュの一覧は特権が要る**（無ければ `SQLCODE -443 / SQLSTATE 38501`）。

| スクリプト | 内容 |
|---|---|
| `research-visual-explain-osaka{,2,3,4,5}.mjs` | 調査（サービスの有無・引数・記録の形・`explain only` の可否・`PROCESS_DETAILED_MONITOR` の探索） |
| `research-visual-explain-pub400.mjs` | 7.5・非特権での挙動（版数と権限の差を切り分ける） |
| `research-visual-explain-compare.mjs` | **同一 SQL** で 7.3 / 7.5 を突き合わせる（`osaka` / `pub400` を引数で切替） |
| `research-visual-explain-shapes.mjs` | 結合・集約・副問合せ・UNION で出る記録種別と階層列（`QQQDTN` / `QQQDTL`） |
| `verify-visual-explain-osaka.mjs` | 採取の疎通（hostserver の関数を直接。`pub400` 引数あり） |
| `verify-visual-explain-e2e.mjs` | **REST 経由の統合検証**（`buildApp` を通す。`pub400` 引数あり） |

```sh
node --env-file=.env scripts/verify-visual-explain-e2e.mjs          # SR-OSAKA (7.3・全特権)
node --env-file=.env scripts/verify-visual-explain-e2e.mjs pub400   # PUB400 (7.5・特権なし)
```

実測で分かった落とし穴（コードのコメントにも残してある）:

- **`explain only`（文を実行せずに計画だけ）は実現できない。** prepare だけでは最適化記録が 0 件で、
  最適化は `open` の時点で起きる。提供しているのは「行を返さない」モードで、**文はホストで実行される**。
- **同じ接続で同じ文を 2 回完全オープンすると、3 回目以降は最適化記録が出ない**
  （ODP の再利用）。`host-plan.ts` は新しい接続で 1 度だけやり直して回復する。
- **`3006` / `3015` は 7.5 だけに出る**（同一 SQL で突き合わせて確認）。未対応種別として素通しする。
- **結合の順位は `QQJNP`（ダイヤル）が持つ。** 2 表で 1・2、3 表で 1・2・3。IBM i の結合は
  **左深**なので、`((ダイヤル1 ⋈ ダイヤル2) ⋈ ダイヤル3)` の木がそのまま組める（ACS と同じ絵になる）。
  `3007`（打ち切り）は `QQJNP=0`＝参加していない。方式は `QQC21`（実測は `NL` のみ）。
  ⚠ **`QQC22`（結合種別）は当てにならない**——`LEFT OUTER JOIN` を流しても `IN` だった。内部/外部を名乗らせない。
  ⚠ **列名から当たりを付けて「階層は無い」と結論しない。** 実際 `QQQDTN` / `QQQDTL` の 2 列だけを見て
  「木は組めない」と決めていた（282 列ある）。利用者の指摘で全列をダンプし直して分かった。
- **ACS の「テーブル・プローブ」は `QVC14`（索引のみアクセス）が `N` のとき。** 同じ結合を
  `SELECT *` と「索引のキー列だけ」で流して**全列の差分**を採ると、意味のある違いはこの 1 列だけだった。
  **差分を採る**のが効く——値の一覧を眺めても、どの列が効いているかは分からない。
- **ACS の「最終選択」は `3019` の `QQI7`**（返した行数）。**索引名は `3001` の `QQ1000`**
  （`QVINAM` は索引が載るファイル名で、ACS が出すアクセスパス名ではない）。
- ⚠ **同じ列名でも記録種別ごとに意味が違う。** `QQC21` は結合に参加する記録（`3000` / `3001`）では
  結合方式（`NL`）だが、`3019` では `A1`、`3014` では `N` が入る。一律に「結合方式」と表示すると
  **結合していない記録に嘘のラベルが付く**。属性に出すときは `QQJNP >= 1` で絞る。
  同じことが `QQI5` にも当てはまる（`3001` では索引の項目数 213、`3014` では最適化時間 9）。
- **読む列は焼き込まず、`QSYS/QAQQDBMN` の列一覧をホストから引く**（読める 279 列）。
  版数差で無い列を `SELECT` に並べると採取ごと落ちるため。引けなければ固定列へ落とす。
  ⚠ `CCSID <> 65535` だけで絞ると**数値列が落ちる**（数値列の CCSID は NULL）。
- **列の意味はホストからは取れない。** `QSYS2.QQQ3000` 系のビューは存在せず（実測 0 件）、
  `QAQQDBMN` の `COLUMN_TEXT` は名前付きの列にしか無い。ACS が名前を付けている
  `QQI*` / `QQC*` / `QVC*` は空。**名前は ACS 出力との値の一意一致で確かめたものだけ**に付ける。
- **ただし 71 列には IBM の論理名がある**（`COLUMN_TEXT` / `COLUMN_HEADING`）。
  ⚠ **日本語システムではそれが壊れて届く**——DBCS 混在を SBCS（カタカナ）表で 1 バイトずつ
  変換された形で、SO/SI が文字として残る（`QQTFN` → `"｣ﾃ｣ｰ｣J…"`）。1 文字 = 元の 1 バイトなので
  カタカナ表を逆に引けば戻せる（`plan-column-text.ts`）。**カタカナ表に無いバイト（29 個）は
  ホスト側で潰れていて戻らない**ので、その行は論理名として採用しない。
  `DSPFFD` の出力ファイルから読む道は**さらに崩れる**ので使わない（実測）。
- **同じ文のテキストが `QQUCNT` の違う 2 つの群に出る。** `STRDBMON` 直後の `QQUCNT=0` は
  モニターの目印（`3018`）と「これから実行する文」の要約（`1000`）だけを持ち、**計画記録を 1 件も持たない**。
  群は現れた順なので `QQUCNT=0` が先に当たる——**文が一致した最初の群**を採ると必ず空の計画になる。
  `pickStatementRecords` は**計画記録（`QQQDTN`）を持つ群だけ**から選ぶ。
- ⚠ **検証にリテラルを含む文だけを使わない。** `WHERE X = 'QSYS2'` はホストが `?` に置き換えて
  記録する（値は `3010`）ので `QQ1000` が投げた文と一致せず、**選び方が壊れていても件数で選ぶ 2 段目に
  落ちて通ってしまう**。上の欠陥は QSYS2 の検証文ばかり試していたため見逃され、
  `SELECT * FROM ASAOLIB.M_MENUTR T1 INNER JOIN …` のようなリテラルの無い実文で
  利用者が踏んだ。`verify-visual-explain-osaka.mjs` は**リテラルの無い文**も必ず通す。

### 記録種別・MCP・実ブラウザの検証

| スクリプト | 内容 |
|---|---|
| `research-visual-explain-records.mjs` | **記録種別ごとにどの列が埋まるか**を実測（形の違う SQL を 9 通り。`SELECT *` で 282 列）。名前を与える根拠を採る |
| `verify-visual-explain-mcp.mjs` | MCP ツール 2 本を実クライアントから叩く（`pub400` 引数あり） |
| `verify-browser-visual-explain.mjs` | 実ブラウザ（Playwright）で計画の描画・一覧ペイン・保存を確認。スクリーンショット 8 枚 |

**記録種別に名前を与える基準**: IBM Documentation の "Database monitor view NNNN - …" と
**こちらの実測が一致したものだけ**。`5002` / `5005` / `3018` は観測したが文書化された名称を
確認できていないので `other`（「記録 nnnn」＋属性）のまま。

⚠ **MCP でエラーを返すときに `structuredContent` を載せてはならない。**
SDK は `isError` に関わらず `outputSchema` で検証するので、エラーの形（`{error:…}`）を載せると
**クライアント側が例外を投げて呼び出しごと失敗する**。`listTools()` を呼んだクライアントでだけ
起きるため気づきにくい（`mcp-tools.ts` の `errorResult` の注記）。

## PCML（プログラム界面の記述）から呼ぶ

`pgm:call` は**位置指定**で、構造体は base64 の手詰めになる。PCML はその上に載る「記述」で、
構造体と配列を**名前**で扱えるようにする。出どころは**コンパイラ**——
jt400 の `ProgramCallDocument` は構築子 8 つのいずれもホストへ問い合わせない（原典で確認）。
CL の `QCDRCMDD` に当たるものは RPG には無い。

| スクリプト | 内容 |
|---|---|
| `research-pcml-osaka.mjs` | `CRTBNDRPG … PGMINFO(*PCML) INFOSTMF('/…')` が**実機で通るか**を測り、吐かれた PCML を採る。試験片 `ASAOLIB/PCMLTST` もここで作る |
| `research-pcml-layout-osaka.mjs` | **宣言どおりのバイト並びで実機が受け取るか**を、生バイトで組んで測る（構造体＝連結／配列＝反復の確認） |
| `verify-pcml-osaka.mjs` | 同じ往復を**名前だけ**で行う（手詰めが消えたことの確認）。記述は IFS から読む |
| `verify-browser-pcml-osaka.mjs` | 実ブラウザ（Playwright）で PCML ペインを操作。読み込み・入れ子の描画・呼び出し・結果の表示・断り方まで |

実測（SR-OSAKA）で確かめたこと:

- **PCML は 819（ISO 8859-1）でタグ付けされる**。UTF-8 ではない
- RPG の `const` は `usage="input"`、それ以外は `inputoutput`
- `int(10)` → `length="4" precision="31"`、`int(20)` → `length="8" precision="63"`（**符号つき**）
- **構造体はメンバーの連結、配列は要素の反復**——詰め物も境界合わせも無い

⚠ **`.pcml` の `count` は整数とは限らない。** 他の項目名を書くと**その値が件数**になる
（IBM の一覧 API はこの形）。**件数が決まらないまま呼んではならない**——0 件として組むと、
ホストは「0 件ぶんの領域」に書き込んで領域外を壊す。`buildPcmlCall` は決まらなければ拒否する。

⚠ **10 進や整数の変換の失敗には項目名を付ける。** `stringToPackedDecimal` は値しか知らないので、
そのままだと `数値として読めません: ""` だけが出る。構造体の中では**どの欄か探せない**。
`encodeArgValue` が呼び名を前置する（実ブラウザの検証でこれを踏んだ）。

### 実機 API の PCML（IBM 同梱の記述）

`jtopen` は `.pcml` を **16 本**同梱している。**実機 API の記述はこれが正解**なので、
6 本を `packages/hostserver/test/fixtures/pcml/` に**手を入れずに**置いてある
（整えると「IBM が配る形」を通したことにならない）。

| スクリプト | 内容 |
|---|---|
| `verify-pcml-api-osaka.mjs` | IBM の `qsyrusri.pcml` のまま QSYRUSRI を呼び、返った値を **QSYS2.USER_INFO と突き合わせる** |
| `verify-browser-pcml-api-osaka.mjs` | 実ブラウザで IBM の記述を貼り付けて呼ぶ。予約域の見え方と `outputsize` の断り方まで |

実測（16 本の使用状況）:

| 属性 | 本数 | 意味 |
|---|---|---|
| `outputsize` | **14 / 16** | 受取域の大きさ。**入力項目の名前**で指すのが 34 件、整数が 7 件 |
| 名前なしの `<data>` | 多数 | 予約域。**触れないが場所は取る** |
| `offset` / `offsetfrom` | 5 / 16 | 飛び先が**出力の値**で決まる |
| `minvrm` / `maxvrm` | 3 / 16 | **引数の本数**を変える |

⚠ **`length` は整数とは限らない。** `length="bytesReturned"` のように**他の項目を指す**
（原典の `m_LengthId`）。指す先が出力なら呼ぶ前には決まらない——その場合は
「出力なので呼ぶ前には決まりません」と言って断る。「入れてください」では入れようがない。

⚠ **`minvrm` / `maxvrm` は並びではなく本数を変える。** 原典は版に合わない要素を
**引数の列から丸ごと落とす**（`childParms[i] = null` にして詰め直す）。無視すると `MCH0802`。
版は `signon` の `rawVersion` がそのまま使える——**符号化が原典の `generateVRM` と同じ**
（`(V << 16) + (R << 8) + M`）。

⚠ **受取域が記述の要る大きさより小さければ断る。** ホストが書ける場所が足りず、
返るバイトが途中で切れる——**切れたことに気づけない**形の失敗になる。

### 飛び先つきの記述（出力を先頭から順に解く）

IBM の書式は「前詰め＋末尾に可変長」で、**可変長の位置・件数・長さ・CCSID を頭の整数で知らせる**。
呼ぶ前に割り付けを固定できないので、**返ってきたバイトを先頭から順に解く**
（`packages/hostserver/src/command/pcml-read.ts`）。

| スクリプト | 内容 |
|---|---|
| `verify-pcml-dynamic-osaka.mjs` | IBM の `RUser.pcml`（`USRI0300`）を呼び、**ホームディレクトリを QSYS2.USER_INFO と突き合わせる** |
| `verify-browser-pcml-dynamic-osaka.mjs` | 実ブラウザで同じことをする。件数が出力で決まる行の見せ方まで |

実測（SR-OSAKA / `USRI0300`）:

```
offsetToHomeDirectory = 722          ← 飛び先はホストが書いた値
homeDirectory CCSID   = 1200         ← **UTF-16**
homeDirectory 長さ    = 20 バイト     ← 出力で決まる
homeDirectoryNameValue = "/home/***"  ← SQL の HOME_DIRECTORY と一致
localePathName        = "*SYSVAL"     ← 長さも出力で決まる
```

⚠ **IFS の道は EBCDIC で返らない。** `ccsidOfTheReturnedHomeDirectoryName` の実測値は
**1200（UTF-16）**で、`codecForCcsid`（EBCDIC 専用）では読めない。
`pcml-read.ts` は 1200 / 13488 / 17584 / 1208 / 819 / 367 / 1252 を `TextDecoder` に回す。
**測って初めて分かった**もので、記述からは読み取れない。

⚠ **相対名の起点は「親」であって「自分」ではない。** `RUser.pcml` のしおり
（`<data type="byte" length="0" offset="…"/>`）は**名前が無い**ので完全名を持たない。
自分の完全名から遡ろうとすると起点が消え、末尾一致の逃げ道を作ると
**無関係な `<struct>` 定義の項目を黙って掴む**（実際に踏んだ）。逃げ道は消した。

⚠ **前には戻らない。** 飛び先が現在位置より前なら何もしない（原典と同じ）。
`RUser.pcml` は 3 つのしおりが同じ `offsetfrom="0"` を使うので、
戻る実装だと 2 つ目以降で位置が壊れる。
