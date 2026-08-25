# 実機 E2E / 診断スクリプト

`packages/tn5250` の `Session5250`（および MCP/WS）を実 IBM i（既定 pub400.com）に対して動かす E2E・診断スクリプト。

> **ここは実機に当てるものだけ。** ソフトウェアのビルドや成果物の検査は置かない
> （例: `crates/hllapi/tools/`）。**`build-*.mjs` は「IBM i 上にテスト用の資産を作る」**
> 意味であって、ソフトウェアをビルドするスクリプトではない——同じ `build-` でも別物。

> **3270（メインフレーム）の検証環境はここではない。** `@ts5250/tn3270` は実 IBM i ではなく
> **docker 上の TK4-（MVS 3.8j）**に当てるため、環境構築は
> `packages/tn3270/test/harness/testenv.sh` に置いてある（`sh …/testenv.sh up`）。
> 参照クライアントは `s3270`（x3270 suite・BSD-3-Clause）。

## 実行方法

ビルド後、資格情報を環境変数で渡して実行する（`.env` は gitignore、パスワードはコミットしない）:

```sh
npm run build
node --env-file=.env --env-file=.env.verify scripts/<name>.mjs
```

`.env` は秘密、`.env.verify` は実機の識別子（下記）。**2 つとも渡す。**

必要な環境変数: `PUB400_USER` / `PUB400_PASSWORD`（自動サインオン）。任意: `PUB400_HOST`（既定 pub400.com）、
`PUB400_DEVNAME`、`PUB400_LIB`（既定 `TESTLIB`）。各スクリプトは成功で終了コード 0、失敗で 1。

> 🔑 **実機の固有名はリポジトリに置かない。** システム名・ライブラリ名・装置名・ユーザー名は
> すべて環境変数から採り、コード側の既定値は `TESTLIB` / `AS400` のような**当たり障りのない
> プレースホルダ**にしてある。書かないと既定値のまま実機に当たり、「ライブラリが見つからない」で落ちる。
>
> 置き場は**秘密かどうかで 2 つに分ける**（どちらも `.gitignore` 済み）。
>
> | ファイル | 中身 | 変数 |
> |---|---|---|
> | **`.env`** | 秘密。アプリ（`start.sh` / Electron）もこれだけを読む | `AS400_SECRET_KEY`（master key・自動生成）/ `AS400_HOST` / `AS400_USER` / `AS400_PASSWORD` / `PUB400_HOST` / `PUB400_USER` / `PUB400_PASSWORD` |
> | **`.env.verify`** | 秘密でない識別子。**エージェントが読んでよい情報源** | `AS400_SYSTEM`（`profiles.local.json` 上のシステム名）/ `AS400_SESSION`（同セッション設定名）/ `AS400_LIB` / `AS400_DEVNAME` / `AS400_PRTDEV` / `AS400_IFS_DIR` / `PUB400_LIB` / `PUB400_PRTDEV` |
>
> ひな形は [`.env.verify.example`](../.env.verify.example)（追跡）。`.env.verify` はそこからコピーして作る。
> **`--env-file` の複数指定は Node 20.12+** が要る（`package.json` の `engines` はアプリの要件なので `>=20` のまま）。

## 検証に使う実機

| 機械 | 指定する変数 | 版数 | パスワードレベル | 備考 |
|---|---|---|---|---|
| **実機**（日本語機） | `AS400_*` | **IBM i 7.3**（`V7R3M0`） | **0**（DES 経路） | CCSID 5035 / SBCS は 5026 系。検証オブジェクトは `AS400_LIB` に置く |
| **PUB400** | `PUB400_*` | **IBM i 7.5**（`V7R5M0`。2026-08-02 に実測） | **3**（SHA 経路。同日実測） | 1 往復 4〜7 秒。**特殊権限なし** |

> ⚠ **2026-08-01 より前の記録は実機を「IBM i 7.5」と書いているが誤り。**
> `.aidev/works/*` の research / walkthrough 等 15 件超が該当する（過去の記録なので
> 書き換えていない）。**7.3 で測った結果**として読むこと
> （経緯は `.aidev/works/20260801-realhost-version-and-pwdlevel/`）。

版数は**表示 1 つを信じず 2 経路で**確かめる。「実機も 7.5」は、おそらく誰も測らずに
書かれて広まった:

```sh
# 1. サインオンサーバーの VRM
node --env-file=.env --env-file=.env.verify tools/hostserver-check/dist/main.js --host "$AS400_HOST"
#    → "server version : V7R3M0" / "password level : 0"

# 2. 累積 PTF パッケージ（ID は Cyyddd<rrr> で末尾 3 桁が版数）
node --env-file=.env --env-file=.env.verify tools/hostserver-check/dist/sql.js \
  "SELECT PTF_GROUP_NAME, PTF_GROUP_DESCRIPTION FROM QSYS2.GROUP_PTF_INFO"
#    → SF99730 / "CUMULATIVE PTF PACKAGE C9116730" ＝ 7.3.0
```

`QSYS2.ENV_SYS_INFO` は実機に**無い**（`SQLCODE=-204`）ので、版数の確認には使えない。

> PUB400 は切断後もデバイスをしばらく保持するため、同名デバイスへの即再接続は
> `closed during negotiation` になりやすい。E2E 系はリトライごとにデバイス名を変える。

## 表示属性 E2E（DBCS・文字色・背景色・属性・インライン色）

`TESTLIB` に作った 2 組の DDS/RPGLE フィクスチャで、エミュレーターの属性デコードを検証する。

- **CLRTDSP/CLRTPGM** — フィールド単位の `COLOR`/`DSPATR` ＋ DBCS(日本語) 出力欄（表示）
- **INLTST/INLPGM** — インライン色制御（フィールドデータ中に属性バイト 0x20–0x3F を埋め込み、桁ごとに色切替）（表示）
- **INPTST/INPPGM** — フィールド型別の入力（数値/A(SBCS)/O(open)/J(pure DBCS)）＋DBCS 日本語のエコー往復（入力）

| スクリプト | 内容 |
|---|---|
| `build-attrtest.mjs` | `TESTLIB` に上記 3 組を作成・コンパイル（冪等）。ソースはコマンド行から `RUNSQL INSERT` で投入（IFS 不要）。 |
| `verify-browser-command-prompt.mjs` | **コマンド入力支援**（実機の F4 相当・実ブラウザ）: 定義を引いて欄が並ぶ／必須の印／選択肢／既定値の表示、**「確かめる」で走る文字列そのもの**が見えること、実行してホストのメッセージが返ることまで。 |
| `verify-command-template.mjs` | **CL コマンドのテンプレート**（`QCDRCMDD`）: 定義を引き、引用の要る値（`'`・空白・小文字・日本語）でコマンドを組み、実機で通して**読み戻して一致**を見る。許されない値を打つ前に弾くことも。 |
| `verify-attributes.mjs` | 表示検証: `CLRTPGM`（7 色・反転・下線・高輝度・桁区切り・点滅・DBCS）＋ `INLPGM`（埋め込み属性バイトの色切替）。**CCSID 1399**。 |
| `verify-input.mjs` | 入力検証（core）: `INPPGM` の 4 欄の型（numeric/SBCS/open/pure）＋ O/J のエコー往復。**CCSID 1399**。 |
| `verify-browser-dbcs.mjs` | 入力検証（実ブラウザ）: DBCS 往復＋**フィールド型ルール**（J は SBCS 不可・A は DBCS 不可・NUM は英字不可）を実 IME(CDP)で。 |
| `verify-browser-render.mjs` | 描画回帰（実ブラウザ）: 反転(背景色)セルの文字色≠背景色（文字が見える）／DBCS 全角の縦位置が同行テキストと揃う、を計算スタイル・幾何で検証。 |
| `verify-browser-select.mjs` | 矩形選択回帰（実ブラウザ）: カーソルが選択の始点に置かれ、マウス／キーボードで広げても動かない（ACS 相当）／ダブルクリックで語を選択（入力欄上の native 語選択を畳んで blur できるか）／カーソルが選択ハイライトより上に描かれる（jsdom は scoped CSS を解決しないため）。 |
| `verify-browser-paste.mjs` | 複数行ペースト回帰（実ブラウザ・12 項目）: `STRSQL` の SQL 入力エリア（独立した入力欄が縦に並ぶ）へ矩形の形のまま落ちる／書いた範囲だけ上書きし後ろの既存文字を残す（`123456` へ `789` → `789456`）／行またぎ欄（コマンド行）でも折返し先の同じ桁へ落ちる／帯の幅で折り返しあふれは次の帯行の同じ桁へ／挿入モードは後続を右へずらし入り切らねば「挿入する余地がありません」で何も書かない／ペースト後もカーソルが動かない。**SQL は実行しない**（Enter を押さない）ためホストは変更しない。 |
| `verify-browser-adjust.mjs` | ローカル編集キーと FFW の ADJUST 回帰（実ブラウザ・実機・15 項目）: Field Exit（Ctrl+Enter）がカーソル以降を消して `CHECK(RZ)`＝ゼロ埋め／`CHECK(RB)`＝空白埋めで右寄せし次の欄へ進む／`CHECK(MF)` は桁を動かさない／符号付き数値欄は指定が無くても空白右寄せし符号桁を残す／Erase EOF（Ctrl+Delete）は消すだけで欄を出ない／Erase Input（Ctrl+Backspace）で全欄クリア。**最後に Enter を送り、ホストが受け取った値（`[000012]` / `[    12]`）まで確かめる**。**要 `TESTLIB/ADJPGM`**（`build-adjtest.mjs`）。 |
| `verify-screen-size.mjs` | 画面サイズ検証: 24x80 / 27x132 × SBCS / DBCS の端末タイプと、`STRSEU`（*DS4 を持つ画面）が実際にワイドで来るか。DBCS はカラー端末（G02/C01）を掴めているかも見る。**要 `TESTLIB/QDDSSRC`**。 |
| `verify-printer.mjs` | プリンターセッション検証（core・実機）: `PrinterSession` で待ち受け → 表示セッションから自前スプールをそのプリンター OUTQ へ回し（`CHGJOB OUTQ`＋`DSPLIBL OUTPUT(*PRINT)`）→ ライターの用紙タイプ問い合わせ（`CPA3394`）に `I` で応答 → SCS を受信して "Library List" 帳票を桁揃えで展開できることを確認。**自分のデバイスにのみスプールを回す**ためホストを汚さない。 |
| `verify-printer-dbcs.mjs` | DBCS プリンター検証（core・実機・CCSID 1399）: `TESTLIB` のライブラリテキストを日本語に変えて `DSPLIBL` を印刷 → SCS 中の SO/SI 付き全角を受信し、帳票に日本語が桁揃えで載ることを確認（検証後にテキストを戻す）。**要 TESTLIB**。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-attrtest.mjs      # 初回/再作成（既存なら不要）
node --env-file=.env --env-file=.env.verify scripts/verify-attributes.mjs   # 表示検証
node --env-file=.env --env-file=.env.verify scripts/verify-input.mjs        # 入力検証（core）
node --env-file=.env --env-file=.env.verify scripts/verify-browser-dbcs.mjs # 入力検証（ブラウザ/IME）
```

補足:
- 実機では素の `DSPATR(BL)` はホストが赤・非点滅(0x28)を送るため、点滅は `COLOR(RED) DSPATR(BL)`(0x2A) で検証する。
- **DBCS（日本語）は CCSID 1399 のセッションが必須**。既定 `pub400`(CCSID 37) では表示も入力もできない。
  `profiles.json.example` の `pub400jp`(CCSID 1399) のように DBCS プロファイルを用意して接続する
  （ブラウザ操作でも同様。手動接続フォームなら CCSID に 1399 を指定）。ブラウザでの日本語入力は IME 経由（compositionend で取り込み）。
- DBCS 入力欄は DDS データ型 `O`（DBCS-open）。フィクスチャは E2E 再利用のため TESTLIB に残置している。

## 反転（背景色）の連続（実機 / `AS400_LIB`）

行間（line-height の余白）は文字要素の背景では塗られないので、反転が縦に続くと行と行の間に
地色が横線として並ぶ（ACS は隙間なく繋がる）。**jsdom は描画しない**ので、隙間そのものは
実画素でしか測れない——単体テストが見ているのは *隙間を作らない書き方* だけ。

| スクリプト | 内容 |
|---|---|
| `build-revtest.mjs` | `AS400_LIB` に `REVTST`（画面 2 つ）と `REVCL` / `REVCL2` を作る。**画面1（`REVCL`）＝同じ幅の反転を縦に 8 行 ＋ 別色で 3 行**（行間の隙間を見る）。**画面2（`REVCL2`）＝広い帯（32 桁）と狭い帯（12 桁）を交互に 7 行、1 本ずつ別の色**＋その上下に文字（帯の中と外に同じ文字。**帯とは別の色**）で、**延ばした背景が上下へ被っていないか**を見る。同じ色で重ねると被った先も同じ色で**目にも実画素にも出ない**ので、隣り合う帯は必ず色を変える。反転は**空白だけの定数**——文字があるとその画素は反転の文字色（＝地色と同じ値）になり、隙間と見分けが付かない。 |
| `verify-browser-reverse-rows.mjs` | 回帰 E2E（実ブラウザ＋実機・23 項目）。**web-ui と MCP の HTML を同じ物差しで測る**。撮った PNG を data URI でブラウザへ戻し、canvas の `getImageData` で読む（Node 側に画像デコーダーを持ち込まない）。**隙間**（画面1）＝反転の塊を縦に走査して地色の画素を数える。**はみ出し**（画面2）＝広い帯だけが届く桁で塗った高さを測り、**行送りとフォントの内容領域の大きい方**を超えないこと／隣の行の**内容領域**に隣接する帯の色が入らないこと／その行の文字の画素が帯の外の対照と同数であること。⚠ 帯の色は 1 本ずつ違うので**色は帯ごとに採る**——1 本目の色で全部を測ると 2 本目以降が「帯ではない」と判定され、高さが 1 画素になる（実際に踏んだ）。⚠ **隙間が出るかはフォントの縦メトリクス次第**——この環境の既定（Noto Sans Mono CJK JP）は内容領域が行送りより大きく元から隙間が出ないので、総称 `monospace` へ差し替えた 2 周目が本番。⚠ 桁と幅が同じでも**縦に途切れていれば別の塊**として測る（間の普通の行がまるごと「隙間」に化ける）。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-revtest.mjs              # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-browser-reverse-rows.mjs
```

手で見るなら `CALL <LIB>/REVCL`（隙間）と `CALL <LIB>/REVCL2`（はみ出し）。どちらも Enter で終わる。

**VT も同じ穴を持つ**（`VtPane.vue` は別の描画系）。こちらは**実機を使わない**——
検証用の telnet ホスト（`scripts/vt-telnetd`）に繋いで測る。VT のサインオン失敗は
`QMAXSIGN` に数えられるので、実機で試し撃ちしない。

| スクリプト | 内容 |
|---|---|
| `verify-browser-vt-reverse.mjs` | 回帰 E2E（実ブラウザ＋docker の telnet ホスト・6 項目）。背景色（SGR 40-47 / 反転 7）の行が縦に続く塊に**地色の画素が無い**／幅違いの帯で**塗りが行送りを超えない**／背景色の有無で**桁がずれない**。⚠ 直す前は 8 行の塊に地色が 28 画素出る（確認済み）。 |
| `verify-browser-vt-reverse-ibmi.mjs` | 回帰 E2E（実ブラウザ＋**pub400 の VT**・10 項目）。同じ物差しで**実 IBM i** を測る——VT の翻訳（5250 → ASCII）はホストがやるので、docker の Linux が出す背景色とは出どころが別。`<LIB>/REVCL` / `REVCL2`（`build-revtest.mjs` を pub400 に向けて作る）を CALL して測り、`page.addStyleTag` で**修正前相当に戻した比較**まで取る（実測: 28 画素 → 0）。⚠ 履歴が積もるので測る枠は `.vt-pane`（見えている範囲）。⚠ サインオンの失敗は QMAXSIGN（pub400 は 5）に数えられる。⚠ 実測: IBM i の VT は `COLOR()` を落とし **reverse だけ**を送ってくる。 |

```sh
docker build -t ts5250-vt-telnetd scripts/vt-telnetd
docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd
node scripts/verify-browser-vt-reverse.mjs
docker rm -f ts5250-vt

# 実 IBM i（pub400）でも測る。テスト画面は先に pub400 側へ作る
env $(grep -E '^PUB400_(HOST|USER|PASSWORD)=' .env | sed 's/^PUB400_/AS400_/') AS400_LIB=$PUB400_LIB \
  node --env-file=.env --env-file=.env.verify scripts/build-revtest.mjs
node --env-file=.env --env-file=.env.verify scripts/verify-browser-vt-reverse-ibmi.mjs
```

> 📌 **`RUNSQL` でソースを入れるときは `DECMPT(*PERIOD)` を付ける。** 既定は `*JOB` で、
> **pub400 は `QDECFMT=J`（小数点がカンマ）**。`(1.00,0,…)` は `SQL0104`、`(2,0,…)` は
> `2,0` が 1 個の数と読まれて `SQL0117`（値の数が合わない）になる。実機（日本語機）では
> たまたま通っていたので、**pub400 に向けた瞬間に落ちる**。`build-*.mjs` の投入は対応済み。
> なお SQL ホストサーバー経由（`DbConnection` / `executeStatement`）はこの影響を受けない。

> 📌 **塗る高さは「文字ランの箱＝行送り」で決める**（`display:inline-block` ＋ `height:1.25em` ＋
> `vertical-align:top`）。**固定量を足す手は使わない**——必要な量は「行送り − 内容領域」÷2 で、
> 内容領域はフォントごとに違うため。同じ HTML をフォントだけ替えて測った実測:
>
> | 方式 | 内容領域 1em のフォント | DejaVu Sans Mono | Noto Sans Mono CJK JP |
> |---|---|---|---|
> | box-shadow で 0.125em+0.5px | +0.25px | **+3.2px** | **+6.25px** |
> | 行で切り取る（`overflow:hidden`） | +0.25px | +0.24px | +0.25px（縦連続で 2 画素の隙間） |
> | **箱を行送りに合わせる（現行）** | +0.25px | +0.24px | **+0.25px・隙間 0** |
>
> はみ出しは画面2（`REVCL2`）が機械的に捕まえる。⚠ **手元で症状が出ないことは直っている証拠に
> ならない**——隙間もはみ出しもフォントの内容領域次第で出たり出なかったりする。

## テスト自動化のテンプレート

`example-automation.mjs` は **Session5250 でテスト自動化を書くための雛形**（LLM 非依存・ヘッドレス。
自動化の三択のうち「決定論的ヘッドレス」＝最軽量。CI/リグレッション向き）。

- 極小ハーネス `test(name, fn)` ＋ `assert()` で pass/fail 集計 → `process.exit`。
- 薄い `Host` ドライバ: `connect()`（デバイス名を変えてリトライ＋メニュー待ち）/ `run(cmd)`（コマンド行→Enter）/
  `key(k, cursor)` / `waitText(t)` / `text()` / `at(r,c)`（セル属性でアサート）。
- 「接続 → 操作 → アサート → `finally` で後始末」を素直に書く。

```sh
node --env-file=.env --env-file=.env.verify scripts/example-automation.mjs
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
node --env-file=.env --env-file=.env.verify scripts/build-pcotest.mjs    # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-pcocmd.mjs    # E2E（28 アサーション）
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
| `build-dttest.mjs` | 実機の `TESTLIB` に `DTMDSPF`/`DTMPGM` を作成（冪等）。**`EDTMSK`（編集マスク）つき入力欄**（6 桁の日付・時刻・SSN、8 桁の日付 `9999/99/99`、対照の素の数値）を並べる。⚠ **`&` は「保護する桁」＝区切りの桁に置く**。数字の桁に置くと `CRTDSPF` が **CPD7494 / CPD7520 でキーワードごと無視**し、「EDTMSK を付けたのに何も変わらない」という誤った観測になる（実際に踏んだ）。DDS の定数は**英数字のみ**（日本語だと `INSERT` が長さ超過する。実測 155 > 153）。`DT_SKIP_PROBE=1` で単独コンパイルを省略できる。 |
| `research-edtmsk.mjs` | 調査用。`DTMPGM` の受信を **core を通さず独立にパース**して SF オーダーを並べ、**`EDTMSK` が欄を分解するか**を見る。⚠ **2026-08-25 訂正: 分解する**（下記の注意）。当時「分解しない」と結論したのは、マスクの `&` を数字の桁に置いていて `CRTDSPF` に無視されていたため。 |
| `research-sysval.mjs` | 調査用。日付・時刻のシステム値の引き方を確かめる。**`QSYS2.SYSTEM_VALUE_INFO` は実在**し、値は `CURRENT_CHARACTER_VALUE` に入る（`QDATFMT=YMD` / `QDATSEP=/` / `QTIMSEP=:`）。候補を 1 つに絞らず順に試す形にしてある。 |
| `verify-browser-prompt.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**`F4` の導線**: 設定 OFF では出ない／ON でフォーカス中の欄の隣に出る／**ラベルはホストの凡例の語**（実機は化けたカタカナで来る）／押すと**ホストが実際にプロンプト画面を返す**（メインメニュー → `MAJOR メジャー・コマンド・グループ`）。画面設定メニューの操作（`.vsm-btn` → `.vsm-row` → `.seg button`）も通る。**追加のホスト資産は不要**。 |
| `probe-dtaq-longwait.mjs` | 調査用。**DTAQ の無限待ち接続が長時間アイドルを越えられるか**を実測する（既定 45 分）。`wait=-1` は read タイムアウトを無効にするので、相手が黙って消えても永久に待つ——`--minutes` で待ち時間を変えられる。**結論は下記の注意書き**。 |
| `verify-browser-watch.mjs` | 回帰 E2E（実ブラウザ＋実機・16 項目）。**データ待ち行列の常駐監視**: 監視開始 → 別接続からエントリを送ると**画面操作なしで履歴に現れる**／タブを離れているときに届くと**未読が付く**／開くと消える／**タブを閉じてもサーバー側の監視は残る**／リロード後に再接続しても**二重に監視を始めない**／**停止しても一覧に残り操作列が「開始」に変わる**／**止めている間に届いたものは消えず、再開すると受け取れる**。資格情報は `passwordEnv` で渡す（この環境では `SecretCrypto.fromEnv()` が使えず `passwordEnc` を復号できない）。**キューは自動で作って消す**（`TESTLIB/DTQWATCH`）。⚠ 停止で行が消える前提だった旧版は `20260801-service-start-stop` で意味が変わっている。 |
| `verify-fresh-service-setup.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。**何も無い状態からサービス開始まで**: `.env` も `profiles.json` も無い**空のディレクトリ**でサーバーを起動し、master key が自動生成される／**ファイルが無くても編集できる**／画面から「保管場所: サーバー設定」でシステムを作れる（**パスワードは暗号化されて保存**）／その子のプリンターに**「サービスとして使う」の欄が出る**／**保存しただけで待ち受けが始まる**（再起動しない）／サービス一覧に「待ち受け中」で出る。⚠ この検証で「立ち上げに失敗しても実体が残らず、理由がログにしか無い」不具合が見つかった。⚠ **セレクタは見出しの完全一致で指す**——`hasText` の正規表現は空白を正規化しないので、折り返した見出しには `\s*` が要る（実際に踏んだ）。 |
| `verify-services-pane.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。**サービス一覧のペイン＋定義変更の反映**: 定義が一覧に出る／**一度も開いていない定義は「未起動」**／サービス ☐ は「対話型」と分かる／**PDF 保存先のパスは画面に出ない**（有無だけ）／**タブを開いても接続が増えない**（`sessions.size === 0` で確認）／**一覧から起動できる**（起動応答 `I902`・常駐として立つ）／停止 → 再開／ルートが `editable` を返す／**保存でサービスが再起動なしに立ち上がる**／**動いているものは保存で切れず「要再起動」が出る**／開始し直すと消える／サービス ☐ と削除で止まって実体が消える。設定は一時ファイルで、実機の `profiles.json` には触らない。 |
| `verify-dtaq-webhook.mjs` | 回帰 E2E（実機・14 項目）。**待ち行列サービスの Webhook 転送**: 実キューのエントリが**実際の HTTP で届く**（本文・キュー名・秘密のヘッダー・本文の署名・配送 id）／**受け手を落としても監視は止まらない**（止まるとホスト側のキューが溢れる）／諦めた分が**「未達」として一覧に出る**／受け手が戻れば届く／**4xx は再試行しない**。受け口はスクリプト内に立て、待ち行列（`TESTLIB/DTQHOOK`）は**自動で作って消す**。⚠ この検証で「未達の数が次の到着まで古いまま」の不具合が見つかった（単体テストでは現れない）。 |
| `verify-service-auth.mjs` | 回帰 E2E（実ブラウザ＋実機・**認証あり**・16 項目）。**サービスの認可**: 管理者は一覧から起動できる／**一般ユーザーは見えるが操作ボタンが出ない**／API を直に叩いてもパスも警告も返らず、設定の一覧は 0 件のまま／**WS へ直接送っても断られ、サーバー側の状態が変わらない**（画面が隠しているだけではないことの確認）。検証用の資格情報は**メモリにだけ置く**使い捨てで、実機のものとは無関係。⚠ この検証で `printer-stop` の拒否が返らずプロセスが落ちる不具合が見つかった（認証オフでは絶対に踏まない）。 |
| `verify-view-cascade.mjs` | 回帰 E2E（実ブラウザ＋実機・12 項目）。**「外観」と「表示」／表示設定の 2 段カスケード**: **移行しても画面の地色が変わらない**（テーマのブロックを「差分を当てる」形から自己完結へ書き換え、選択子から `:root` を外したので、特定度が (0,2,0)→(0,1,0) へ下がる。優先関係が保たれているかは実画素でしか見られない。`AS400_BASELINE_GRID` に前の版で測った地色を渡すと機械的に突き合わせる）／ボタンが `外観`・`⚙ 表示`／**セッション個別のテーマがペインの中だけに効く**（画面 `rgb(247,248,244)`→`rgb(5,13,9)` に対しタブ帯とヘッダーは不変）／既定に戻すと元へ戻る。⚙ 表示のボタンは**ページの中で探して押す**——Playwright の `hasText` はテンプレート由来の改行が入るボタン（`既定に従う（…）`）で当たらないことがある（実際に踏んだ）。**ヘッダーのボタンの高さが 5 つとも揃う**／**「既定に従う」の選択肢が無く既定の値にだけ印が付く**／**スプールでも `⚙ 表示` が出て、効く項目（リンク化・フォント）だけが並ぶ**も見る（`20260802-view-menu-refine`）。 |
| `verify-tabs-own-system.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。**異なるシステムのタブを並べて同時に見る**: A の SQL と B の SQL が**別のタブ**として並ぶ／**それぞれの要求が自分のシステムへ飛ぶ**（Playwright の `request` で**本物の HTTP の body を覗いて**確かめる。ここが本題）／2 システム開いているときだけタブに**システム名**が出て**色帯**が付く／システムを選び直しても**タブが 1 枚も消えない**／**ヘッダーが常に見ているタブのシステムを映す**（タブを押すだけで変わる。`20260802-header-follows-tab`）。システム設定は 2 つとも同じホストを指し、**オブジェクトは何も作らない**（`SYSIBM.SYSDUMMY1` の SELECT を 2 回）。⚠ 2 システム分のペインが**同時にマウントされている**ので、操作は `.pane-slot:not([data-hidden])` で**見えているほうに絞る**——`.first()` だと隠れているペインを掴んで固まる（実際に踏んだ）。⚠ システム選択画面に居るときパンくずの第 1 段は `disabled`。押そうとすると有効になるまで待ち続ける。 |
| `verify-pane-state.mjs` | 回帰 E2E（実ブラウザ＋実機・19 項目）。**開いたタブは閉じるまで生かす**: 打った内容がタブの行き来／メニューへの寄り道／**システムの選び直し**をまたいで残る／一度も開いていないタブはマウントされていない／その間ずっと **5250 の画面の大きさが変わらない**（ペインを包み紙で括り `<main>` を 1 つにまとめたので、高さの連鎖 `main`→`.ws-root`→`.group`→ペイン が切れると縮む。jsdom では検出できない）。2 つ目のシステムは切替の相手に置くだけで**接続しない**。**分割・最大化・タブ移動**も通す（`20260802-keep-pane-state-move`）——最大化で幅が 695→1400px になり、解除で元の比率へ戻り、その間ずっと打った内容が残ること。⚠ タブの D&D は `dragAndDrop` ではなく **`mouse.down`→`move`→`up`** で行う（HTML5 の DnD はマウスを動かさないと `dragover` が出ず、落とし場所の判定が走らない）。⚠ システムを選び直した直後は**メニューに居る**（従来どおり）ので、画面の寸法は「ワークスペース」へ戻してから測ること——隠れている間は 0x0 で当たり前（実際に踏んだ）。 |
| `verify-logpanel-stack.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**ログパネルが画面の中の重ねものより上に来るか**。`.grid` と `.logpanel` の間にスタッキングコンテキストが無いこと（あれば z-index の大小は無意味）／パネルの z-index が 10 ／`.grid` が `z-index:auto` のまま（中の重ねものがこの土俵へ出る前提）／**z-index 7 の板を重ねても `elementFromPoint` がパネルを返す**。option の▾を出すには Opt 欄のある画面まで運転が要るので、**同じ高さの板を代役**にしている。⚠ 直す前（パネル 5）に戻すと 3 項目が落ちることを確認済み。 |
| `verify-cursor-align.mjs` | 回帰 E2E（実ブラウザ＋実機・7 項目）。**カーソルと文字が同じ桁・同じ行に載るか**を実画素で測る。保護領域をクリックした桁へカーソルが行く／カーソルの矩形が**その桁の文字の矩形**と重なる／`.grid` の content box から計算した位置と一致する。**jsdom は scoped CSS を計算しない**ので、ずれそのものはここでしか測れない（単体テスト `grid-overlay-offset.test.ts` が見ているのは *ずれを生む書き方*）。⚠ 縦は上端ではなく**中心**で比べる——`Range` が返すのは字の inline box で、行box とは高さが違う（実測 32.5px vs 37.0px）。装置名は指定せずホストに採らせ、画面を読むだけでオブジェクトは作らない。 |
| `verify-service-ui.mjs` | 回帰 E2E（実ブラウザ＋実機・17 項目）。**サービスの操作 UI**: 設定フォームが `サービスとして使う` ✅ と `自動で待ち受け開始` ☐ と PDF 保存先を**読み込んで開く** → **名前だけ直して保存しても出力設定が消えない**（画面に欄が無い `pdfFontName` も残る）→ `自動で待ち受け開始 ☐` の定義を開くと**停止中**で「待ち受け中…」と嘘を書かない → 開始ボタンで**実機に繋がる（起動応答 `I902`）** → 停止 → **再開できる**（＝停止で本当に装置を手放している）。設定は一時ファイルに書き、**実機の `profiles.json` には触らない**。装置は借りるだけ（既定 `PRT_TEST`）。 |
| `research-sql-exec.mjs` | 調査用。**結果を返さない SQL 文（DML / DDL）が既存の要求で実行できるか**を実測する。`prepareAndDescribe`(0x1803) → `execute`(0x1805) を**マーカーデータ無し**で送り、CREATE / INSERT / UPDATE / DELETE / DROP・構文誤り・存在しない表・SELECT の経路違い・実ライブラリー（SQL 命名とシステム命名）を 1 件ずつ通す。**表は `QTEMP` に作る**（接続ごとに消えるので後片付けが要らない）。⚠ 成否は **SQLCODE** で見る——`reply.rcClass` は `Reply` に無い欄で、参照すると常に失敗扱いになる（この検証で実際に踏んだ）。 |
| `verify-browser-sql-exec.mjs` | 回帰 E2E（実ブラウザ＋実機・13 項目）。**SQL 画面からの更新**: CREATE（**「実行しました」＋実ライブラリーでは警告 `SQLCODE=7905`**）→ INSERT / UPDATE / DELETE（**「N 行に影響しました」**）→ SELECT で**ホストの表が実際に変わったこと**を確認 → 存在しない表は `SQLCODE=-204` で失敗 → `?` 付きは実行前に断る → `;` 区切りの混在でタブが 2 つ（非クエリと表）→ DROP。表は `TESTLIB/SQLEXECB` を**自動で作って消す**。資格情報は `passwordEnv` で渡す。 |
| `research-sql-cancel.mjs` | 調査用。**結果セットの早期打ち切り**を実測する。上限 1/50/99/100/101/200/250 で打ち切り、**打ち切った直後に同じ接続で SELECT / UPDATE が通るか**・fetch の**往復回数と受信バイト数**・ブロッキング係数を絞った効果・「続きがあるか」を上限＋1 行で判定できるかを並べる。**結論: 打ち切りはホストに副作用を残さない**（20,000 行で全件 201 往復 / 1,191,336 バイト / 2,072ms → 上限 200 で 2 往復 / 11,912 バイト / 44ms）。表は `QTEMP` に作るので後片付け不要。 |
| `verify-sql-limit.mjs` | 回帰（実機・8 項目）。**取得量の上限が MCP と REST の両方で効いているか**。20,000 行の表に対し `host_sql`（実際の登録コードを通してハンドラを呼ぶ）が上限 200 で 200 行＋`truncated: true` を返し、**接続込み 177ms** で終わること／**上限ちょうどでは `truncated: false`**（嘘をつかない）／REST 単発経路（`pageSize` 無し）も同じ。表は `TESTLIB/SQLLIMIT` を自動で作って消す。資格情報は `passwordEnv` で渡す。 |
| `diag-qsh.mjs` | 調査用。**QSH（Qshell）が固まる原因**を実測する。メインメニューで `QSH` を実行し、届いたレコードを**実装と独立に**並べて「どのコマンドで捨てているか」を見る。**結論: `ESC 0x03`（SAVE PARTIAL SCREEN・パラメータ 5 バイト・opcode PUT/GET）に応答していなかった**。装置名は実機に登録済みの名前（`WEBSF0`〜）を順に試し、前ジョブの回復画面は `90` で越える。 |
| `verify-browser-qsh.mjs` | 回帰 E2E（実ブラウザ＋実機・6 項目）。**QSH が使えること**: 接続 → メインメニュー → `QSH` で**画面が出る**（従来はここで待機のまま固まった）→ `ls -l /` の出力が読める → 続けて実行すると出力が流れる → F3 で抜ける。装置名は `DEV1` を先頭に空いているものを探す。⚠ 画面の凡例「F3= 終了」と鍵盤ボタンは別物——**ボタンを指定して押す**（`getByText("F3")` は画面の文字に当たる）。 |
| `census-5250-commands.mjs` | 調査用。**実機の画面が実際に使う 5250 コマンドを数える**。読み取り専用の画面 **20 件**（`STRSQL`/`DSPMSG`/`WRKACTJOB`/`WRKSYSSTS`/`DSPJOBLOG`/`WRKSPLF`/`DSPLIBL`/`WRKOBJ`/`STRPDM`/`GO CMDIFS`/`QSH` ＋ **ROLL を狙った古い画面 9 件**＝`GO ASSIST`/`DSPPFM`/`WRKMBRPDM`/`DSPOBJD`/`WRKUSRJOB`/`GO MAIN`/`DSPSYSVAL`/`WRKCFGSTS`/`STRS36`）を巡り、各画面で PageDown/PageUp も送る。**正確さの度合いを分けて出す**——レコード先頭（正確）／実装の未知判定（決定的）／全走査（参考。WTD 内の 0x04 も拾う）。結論は `.aidev/backlog/datastream-commands.md`。⚠ **システムの定義は `profiles.local.json` と `connections.json` の両方を見る**（片方へ移した日に黙って落ちた実績あり）。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-adjtest.mjs      # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-browser-adjust.mjs    # E2E（15 項目）
node --env-file=.env --env-file=.env.verify scripts/build-ffwtest.mjs      # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-browser-ffw.mjs       # E2E（18 項目）
node --env-file=.env --env-file=.env.verify scripts/build-sgntest.mjs      # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-browser-sign.mjs      # E2E（9 項目）
node --env-file=.env --env-file=.env.verify scripts/verify-browser-idle.mjs      # E2E（11 項目・約 5 分かかる）
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
- **`EDTMSK` は欄を分解する**（2026-08-25・実機で訂正。それ以前の「分解しない」は**誤り**）。
  `&` は**保護する桁**なので、区切り（`/` `:` `-`）の桁に置く。数字の桁に置いた過去の検証は
  `CRTDSPF` が **CPD7494 / CPD7520 でキーワードごと無視**していた——「1 欄で届いた」のは
  EDTMSK が効いていなかったからで、分解しない証明にはなっていなかった。
  - 正しい向きで書くと**継続入力フィールド**として届く（実測・生バイト）:

    | DDS | 届いた形 |
    |---|---|
    | `EDTCDE(Y)` ＋ `EDTMSK('  &  &  ')` | **3 欄**（2+2+2）・FCW `8601`/`8603`/`8602` |
    | `EDTWRD('0   /  /  ')` ＋ `EDTMSK('    &  &  ')` | **3 欄**（4+2+2）・同 |
    | `EDTWRD('0   /  /  ')` のみ（対照） | 1 欄・長 10・FCW なし |

    ```
    1d 43 00 86 01 24 00 02   ← SF / FFW=0x4300 / FCW=0x8601（継続入力の先頭）/ 属性 / 長さ 2
    ```
  - **FCW `0x86xx`** は継続入力（下位 1=先頭 / 3=中間 / 2=最終）。**`0x8680` はワードラップで別物**
  - **送信は「先頭区間に全区間を連結して 1 つ」**（tn5250 の `session.c`:
    "All subfields are treated as one and are sent as part of the first subfield."）。
    区間ごとに送るとホストが組み立てを誤る（実機で `2026`/`12`/`31` → `000/00/31` を観測）
  - **マスク無し**の 8 桁欄（`EDTWRD` だけ）は 1 欄で来る。空欄なら 8 桁打つだけで
    ホストが数字を拾って `2026/08/25` を返すが、**既存値の上から 8 桁打つと区切りを上書きして壊れる**
    （`2026123125`）。そのときホストは属性を `0x24` → `0x25`（緑＋**反転**＋下線）に書き換え、
    「小数部分の使用法が正しくないか，あるいは入力した数字が多すぎる。」を返す
    ——**色が変わるのはホストの指示**で、こちらの描画ではない
  - `EDTCDE(Y)` は `8 0` だと `nn/nn/nnnn`（`20/26/0825`）で `9999/99/99` にならない
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

## 打鍵の型規則と「打った通りに送れるか」（実機 / `AS400_LIB`）

**打てるか**だけでは足りない。*打てたものがそのままホストへ届くか*まで見ないと、
「画面には入っているのにホストは別の値を受け取る」「Enter を押しても何も起きない」が
不具合として残る（実機で 3 件出た）。AUDPGM は受け取った値をそのまま画面へ返すので、
入力欄と「HOST RECEIVED」の欄を突き合わせれば端末が何を送ったかが分かる。

| スクリプト | 内容 |
|---|---|
| `build-audpgm.mjs` | `AS400_LIB` に `AUDDSPF`/`AUDPGM` を作る（冪等）。DDS 35 桁の型ちがい——`A`（英数字）/ **`D`（数字専用＝FFW シフト 5）** / **`S`（符号付き数値 `6S 0`＝ワイヤ長 7）**——と、次欄へ飛んだかを見るための後続欄 `NXT`、それぞれの受信値を出す欄（`ETXT`/`EDGT`/`ESGN`）を並べる。RPG の `dcl-f` は **`extdesc`/`extfile` でライブラリーごと名指し**する（*LIBL 任せだと `ADDLIBLE` を忘れた実機で画面が出ない）。⚠ 外部記述はコンパイル時に *LIBL から引かれるので、名指ししないと `RNF2120` で落ちる。 |
| `verify-browser-keystroke-rules.mjs` | 回帰 E2E（実ブラウザ＋実機・11 項目）。①数字専用欄に `.` が入らず**理由が画面に出る** ②数字専用欄の `-` が Field− に化けない（打った桁が消えず次欄へ飛ばない） ③符号付き数値欄の**符号桁に数字が入らない** ④**画面の値とホストが受け取った値が一致する** ⑤ペーストでも送れない値を作らない。⚠ **通知は次の打鍵で消える**ので、弾かれた直後に読む（`1` → `.` → 読む → `5`）。⚠ 出力専用の欄は入力欄ではなく**セル**として出る（`.pane` の `innerText` は `<input>` の値を含まないので、入力欄は `inputValue()`、出力欄は行のテキストから読む）。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-audpgm.mjs               # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-browser-keystroke-rules.mjs
```

手で見るなら `CALL <LIB>/AUDPGM`（F3 で終了）。直す前の実測は
**①`1.5` がそのまま入る（通知なし）／②`-` で次欄へ飛ぶ／③画面 `1234567` に対しホストは `123456`**。

## AID キーと欄データ（CA / CF）・カーソル送り（実機 / `AS400_LIB`）

**`CA` キー（コマンド・アテンション）では欄データを送らない。** どのキーが CA かは
**SOH オーダー（0x01）のヘッダ**でしか届かない——FFW にも SF にも出てこない。
本体 5〜7 バイト目の 24 ビットが F24〜F1 に対応し、立っているキーでは欄データを送らない。

| スクリプト | 内容 |
|---|---|
| `build-keytest.mjs` | `AS400_LIB` に `KEYDSPF`/`KEYPGM` を作る（冪等）。`CA03` / `CA12`（データを送らない）と `CF06`（送る）、入力欄 `IN1`〜`IN3`（`IN1` に **`FLDCSRPRG(IN3)`**）、受け取った値を出す `EKEY`/`EIN1`〜`EIN3` を並べる。 |
| `verify-aid-data-mask.mjs` | 回帰（core 直・実機・9 項目）。**描画は関係ない**ので `Session5250` で直に見る。SOH の 24 ビットを**生レコードから独立にパース**して申告を確かめ、F12（CA）で欄データが届かない／F6（CF）と Enter では届くことを `HOST RECEIVED` で見る。⚠ 直す前の実測: F12 で `IN1="AAA"` がホストへ届いていた。 |

| `verify-browser-cursor-progression.mjs` | 回帰 E2E（実ブラウザ＋実機・5 項目）。`FLDCSRPRG(IN3)` を書いた `IN1` から **Tab で `IN3` へ飛ぶ**／指定の無い欄は画面順どおり／**欄が満杯になった自動送りでも指定先へ行く**。⚠ 直す前の実測: どちらも画面順の次（`IN2`＝`f5c30`）へ行っていた。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-keytest.mjs        # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-aid-data-mask.mjs
npm run build -w @ts5250/web-ui
node --env-file=.env --env-file=.env.verify scripts/verify-browser-cursor-progression.mjs
```

カーソル送りのワイヤ値は欄#1 に `0x8803`（下位バイト＝送り先の**欄番号**）。
**Shift+Tab には効かせていない**——tn5250j は逆引きするが GNU tn5250 はせず、
どちらが実機と同じか確かめる手段が無いため（ACS 不可）。

実機で採った SOH: `len=7 本体=[00 00 00 18 00 08 04]` → エラー行 24、マスクは **F3 と F12 だけ**。

## 外字（UDC）とセンチネルの衝突（実機 / `AS400_LIB`）

CCSID 930 の外字（0x6941〜）は Unicode の**私用面 U+E000〜**へ落ちる。ts5250 は
「表示できないバイト・埋め込み属性」を値の中で運ぶセンチネルにも私用面 U+E000+byte を
使っており、**U+E000〜U+E0FF がまるごと重なっていた**。web-ui は DBCS 欄を編集するとき
値をセルから組み立て直す（`logicalFromCells`）ので、外字がセンチネルと見分けられず
**生バイト 1 つに化けて SO/SI ごと消えていた**。

| スクリプト | 内容 |
|---|---|
| `build-udctest.mjs` | `AS400_LIB` に `UDCDSPF`/`UDCPGM` を作る（冪等）。`O`（DBCS open）の入力欄に外字 1 文字（`x'0E69410F'`＝SO + 6941 + SI）を出し、送り返された値が `x'0E69410FC1C2'`（＋`AB`）かどうかを **SAME / DIFF / NONE** で表示する。⚠ DBCS の欄を持つ表示ファイルは `CRTDSPF … IGCDTA(*YES)` が要る。 |
| `verify-browser-udc-roundtrip.mjs` | 回帰 E2E（実ブラウザ＋実機・7 項目）。外字が**欄に文字として出る**（空白へ潰されない）／末尾に `AB` を打って Enter すると**ホストが SAME を返す**。⚠ 直す前の実測: `RESULT=DIFF`・`ECHO=" AB"`（外字が消えた）。⚠ **字形は出ない**（ホストの外字フォントの話）。見ているのはバイトの identity。**`IN2`** は別件——DDS で `A`（SBCS）と申告した欄に SO/SI 入りの DBCS データが載る形（日本語機では珍しくない）。打鍵せず送り返すだけで原本のバイトが返るか（直す前は `DIFF`＝SO/SI が付け直されて 2 バイト増え、欄からあふれていた）と、**欄に日本語が表示されているか**を見る。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-udctest.mjs        # 初回/再作成
npm run build -w @ts5250/web-ui
node --env-file=.env --env-file=.env.verify scripts/verify-browser-udc-roundtrip.mjs
```

> 📌 **センチネルの基点は BMP の私用面に置けない。** 実測で CCSID 930/939/1399/300/16684 の
> 変換表が U+E000〜U+F83C の 6205 個を使っており、**256 連続の空きが 1 つも無い**。
> 単独ローサロゲート（U+DC00+byte）へ移した理由は `attr-sentinel.ts` の JSDoc を参照。

## EDTMSK 分割欄（区切り文字をまたぐ編集・色・下線。実機 / `AS400_LIB`）

ホストは `EDTMSK` で割った数値欄を、区切り文字（`/`）を挟んだ**複数の別々の欄**として送る
（`Field.continued` = first/middle/last）。ACS はこれを**まるごと 1 つの入力欄**として見せる
——色も下線も区切りで途切れず、Backspace/Delete は区切りをまたいで詰め直す。

| スクリプト | 内容 |
|---|---|
| `build-dttest.mjs` | `AS400_LIB` に `DTMDSPF`/`DTMPGM` を作る。**`D8U`**（8 桁 `EDTWRD('0   /  /  ')` ＋ `EDTMSK` ＋ `COLOR(WHT)` ＋ `DSPATR(UL)`）が色と下線の検証用——**素の欄では差が出ない**。⚠ 接続先は環境変数（`AS400_HOST`）を優先し、`connections.json` に無くても動く。⚠ RPG の `dcl-f` は `extdesc` でライブラリーを名指しする（*LIBL 任せだとコンパイルが落ちる）。 |
| `verify-browser-edtmsk-edit.mjs` | 回帰 E2E（実ブラウザ＋実機・14 項目）。区切りの**色が入力欄と同じ**／**下線が `border-bottom` で同じ高さ**／末尾からの **Backspace ×3 が区間をまたいで詰まる**／先頭の **Delete が後続区間から桁を引き寄せる**／`2026/08/25` を**区切り込みでペーストしても桁がずれない**／**Tab が区間ごとに止まらない**（並び全体で 1 つの欄）。⚠ 8 桁打つと自動送りで欄を出るので、Backspace の前に最終区間へ置き直すこと（さもないと別の欄を消す）。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-dttest.mjs        # 初回/再作成（数分）
npm run build -w @ts5250/web-ui
node --env-file=.env --env-file=.env.verify scripts/verify-browser-edtmsk-edit.mjs
```

直す前の実測: 区切りの色 `rgb(26,127,55)`（緑・入力欄は白）／下線なし／Backspace ×3 で
`2026/08/`（区切りで止まる）／Delete は先頭区間だけ／ペーストは `2026/00/8` にずれる。

## IFS ファイルブラウザ（実機 / /home/USER）

| スクリプト | 内容 |
|---|---|
| `verify-browser-ifs-fileops.mjs` | IFS ペインの操作 E2E（実ブラウザ・実機・18 項目）。`/home/USER/TEST` を作って、**画面の操作だけ**でフォルダ作成／ファイルのアップロード・プレビュー・編集保存・ダウンロード・改名・削除／**フォルダごとのアップロード**（入れ子・日本語名）／zip 一括ダウンロード／フォルダの改名・中身ごと削除まで通す。**API は検証と後始末にしか使わない**（下回りだけ通っても「画面から行えるか」の答えにならない）。 |
| `verify-ifs-limits.mjs` | 上限表示・プレビュー競合・先回り判定の実機検証（15 項目。PR #231）。`/home/user/test` を作り、`GET /limits`／413 に上限が載ること／**上限超過で read を発行しないこと**／ヌルバイト入りの案内／連続選択で最後の 1 つが残ること／zip の上限文言を見る。 |

要点（`verify-ifs-limits.mjs`）:

- **上限を CLI 引数で下げて検証する**（`ifsReadMaxBytes: 4096` / `ifsZipMaxBytes: 1024`）。
  既定 5MiB の超過を作るには 5MB 超を 100KB/s のホストへ置く必要があり、検証のたびには払えない。
  先回りの分岐は「`sizeHint` > 上限」で決まるので、上限を下げれば**同じ経路**を通る。
  ついでに CLI 引数が `/limits` に反映されることも確かめられる。
- **「read を発行しない」は画面を通さないと確かめられない。** `page.on("request")` で
  `/api/host/ifs/read` を数える。API だけ叩いても答えにならない。
- **一覧に出る名前は `USER`（大文字）。** IFS は解決時に大小を区別しないので API は
  `/home/user` でも通るが、画面の行を掴むには格納されている綴りが要る。
- **固定待ちにしない。** 実機は 1 往復が数秒（書き込みで 4〜8 秒を実測）で、`sleep(2500)` だと
  「まだ来ていない」を「壊れている」と読み違える。`.preview .path` が変わるまで待つ。
- **本文は `textarea` の value。** `innerText` には出ないので `inputValue()` で取る。

要点（`verify-browser-ifs-fileops.mjs`）:

- **保存は元より短い内容で試す。** 長くする編集だと通ってしまう——OPEN を「開くだけ」で書くと
  先頭からの上書きになり、41 バイトのファイルに 19 バイト保存して末尾 22 バイトが旧内容のまま残る
  （実機で踏んだ。`FILE_DUPLICATE.createOrReplace` で修正済み）。ホストの `list` が返すサイズまで見る。
- **「保存しました」を待ってから測る。** クリック直後は busy が立つ前なので、
  待たずに一覧を読むと書き込み前のサイズを掴む。
- **フォルダのアップロードは `input[webkitdirectory]` に*ディレクトリのパス*を渡す**（Playwright ≥1.42）。
  ファイル用の入力とは別物なので、セレクタは `:not([webkitdirectory])` で書き分ける。

```sh
node --env-file=.env --env-file=.env.verify scripts/verify-browser-ifs-fileops.mjs
node --env-file=.env --env-file=.env.verify scripts/verify-ifs-limits.mjs
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

`research-lob-threshold.mjs` — **LOB フィールドしきい値（CP `0x3822`）の実測**。
`TESTLIB.LOBTHR`（CLOB / 大きい CLOB / BLOB / DBCLOB）を作り直し、しきい値 0 と 64KB で
列の型コード・行の並び・往復数・受信バイト数を比べる。しきい値以下の LOB は
ロケーターではなく**行データに載って**届き、型コードが `964 CLOB_LOCATOR` → `408 CLOB` に変わる。
**DBCLOB の長さ接頭辞は文字数**（CLOB/BLOB はバイト数）なので、
**全角を含む値でしか取り違えを検出できない**（`20260801-lob-threshold-realhost`）。

`research-lob-free.mjs` — **ロケーターの解放（要求 `0x1819`）の実測**。
解放が効くか／二重解放の戻りコード／接続を閉じた後／番号の配り直し、の 4 点を測る。
**接続を閉じればロケーターは消え、次の接続では同じ番号が配り直される**ので、
単発接続では明示的な解放は要らない。**二重解放は `2 / -816`** で、
原典のコメントが挙げる `7 / -401` とは違った（`20260801-lob-locator-free`）。

`research-dbclob-locator.mjs` — **ロケーター経由の LOB の長さの単位と復号の実測**。
`DBCLOB(CCSID 1200)` と混在 `CLOB` を同じ値で作り、`lobData` の申告長と実際の本体を突き合わせる。
**2 バイト/文字の CCSID でだけ申告長が文字数**（混在・SBCS はバイト数）。
⚠ **SBCS だけで試すと一致してしまい取り違えに気づけない**（`20260801-dbclob-locator-decode`）。

`research-lob-multi-segment.mjs` — **64KB を超える LOB の分割受信の実測**。
`0x1816` の往復を生で覗き、`lobStartOffset` / `lobRequestedSize` / 申告長 / 総長の
**単位がすべて「文字」**であることを確かめる。表は倍々に伸ばして作る
（SQL 文の長さ制限に当たらない）。**finally で必ず消す。**

`verify-lob-multi-segment.mjs` — 上が見つけた不具合が**直ったこと**の確認。
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

`research-lob-big-dbcs-blob.mjs` / `verify-lob-big-dbcs-blob.mjs`
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

`research-sql-table-render.mjs` / `verify-sql-table-virtualize.mjs`
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

`research-device-busy.mjs` — **装置名が使用中のときにホストが返すもの**
（`20260802-device-busy-record`）。同じ装置名で 2 本開き、受信レコードを生で見る。
**装置は作らない**（自分の設定にある `DEV1` を 2 本開くだけ）。

> ⚠ **接続条件を設定と揃えないと症状が出ない。** 既定（CCSID 37 / 24x80）で繋ぐと
> **起動応答より前**の交渉段階で切られ、レコードが 1 つも届かない
> ——「再現しない」と結論しかけた。設定どおり（**CCSID 5026 / 27x132**）にすると、
> ホストが `8902 Device not available.` の起動応答を返すところまで到達する。
>
> ⚠ 実機の `DEV1` は**他の接続が掴んでいることがある**。1 本目が開けないときはそれを疑う。

`research-msgw.mjs` — **MSGW（スプールがライターの問い合わせで止まった状態）の実測**。
既存の仮想プリンター装置を借り、用紙タイプをずらしたスプールで `CPA3394` を誘発して
`retrieveMessage` / `answerMessage` を通す。**ライターは必ず止め、スプールは消す。装置は作らない・消さない。**
装置名は `AS400_PRTDEV`（既定 `PRT_TEST`）。

> ⚠ **実機はプリンターの自動構成を許さない**（`8940`。`QAUTOVRT=200` でも）。
> `CRTDEVPRT DEVCLS(*VRT)` で自作しても `VRYCFG` が `CPF2640`、セッションは `8903`。
> **既存装置を借りるしかない**。
> 上書きは **`OVRPRTF FILE(QPRTLIBL)`**——`DSPLIBL OUTPUT(*PRINT)` が作るスプールの名前。
> 間違えると用紙タイプが揃ったまま印刷され、MSGW にならない（`20260801-msgw-realhost-verify`）。

> 📌 **接続先をハードコードしない。** 出力に焼く説明文（HTML のメタ・画像の注記）も
> `AS400_HOST` から組む——固定文字列にすると、別ホストへ繋いだのに説明文だけ元のまま残り、
> **動作に出ないので気づけない**（`shot-signedon.mjs` / `shot-signon.mjs` に注記）。

## 罫線（GRDATR/GRDLIN）と画面クリアの共存（実機 / `AS400_LIB`）

ホストは**罫線を描いた直後に画面クリアを送ってくる**ことがある（S9R167D で確認）。
罫線には専用の消去コマンド（Clear Grid Line Buffer 0x61）が別にあり、ACS はこのクリアで
罫線を消さない。**画面バッファ・web-ui・MCP の HTML と出口が 3 つある**ので、3 本に分けてある。

| スクリプト | 内容 |
|---|---|
| `build-gridtest6.mjs` | `AS400_LIB` に `GRIDTST6`（罫線 13 本の `GRDRCD` ＋ **OVERLAY 無し**の本文レコード ＋ 対照の OVERLAY 付き）と `GRIDCL8` / `GRIDCL9` を作る。**`DSPSIZ(24 80 *DS3)`＝alternate 未申告**にしてあるのが要点で、27x132 を申告した画面向けの修正が素通りする条件を再現する。⚠ DDS の定数は**機能欄 36 桁**（引用符込み 34 文字）に収める——超えると 80 桁で切られ `CPD7508`＋`CPD7596` が並ぶ。ソース行は SRCDTA の **100 桁**まで（`SQL0404`）。どちらも送る前に落とすようにしてある。 |
| `verify-gridlines-clear-unit.mjs` | 回帰（実機・24x80 と 27x132 の 2 周・10 項目）。**画面バッファに罫線が残るか**。受信レコードを**画面バッファを Proxy で包んで流し直し**、適用器が呼んだ順（`applyGridLines` → `clearUnit`）をそのまま並べる——バイト列の素朴走査は SBA の引数の 0x04 を拾って**過大に出る**ので使わない。`VERIFY_TRACE_OUT` に受信レコードを保存でき、**修正前の実装へ流し直す**証拠に使える（実測: 修正前 0 本 → 修正後 13 本）。装置名は指定せずホストに採らせる。 |
| `verify-browser-gridlines.mjs` | 回帰 E2E（実ブラウザ＋実機・5 項目）。**web-ui が `.grid-line` を実際に描くか**を DOM の本数と画像で見る。画面バッファに残っていても描画側で落ちれば利用者には「出ない」ままなので、バッファとは別に見る。`SHOT_OUT` に画像が出る。 |
| `verify-mcp-gridlines-html.mjs` | 回帰（実機・MCP stdio・10 項目）。**`get_screen_html` の HTML にも罫線が入るか**（`screen-html.ts` は web-ui とは別の描画系）。`MCP_HTML_OUT` に HTML を残す。⚠ MCP の固定形式は全角 1 文字を 2 桁に見せる（「サ イ ン ・ オ ン」）ので、**画面文字の照合は空白を落としてから**行う。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-gridtest6.mjs          # 初回/再作成
node --env-file=.env --env-file=.env.verify scripts/verify-gridlines-clear-unit.mjs
node --env-file=.env --env-file=.env.verify scripts/verify-browser-gridlines.mjs
node --env-file=.env --env-file=.env.verify scripts/verify-mcp-gridlines-html.mjs
```

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

`research-ifs-dataccsid.mjs` — **IFS の新規ファイルに付く CCSID タグの実測**。
`dataCcsid` を指定しない／`1208`／`1399`／既存の上書き、の 4 条件を比べる。
**指定は採用される**が、**既存ファイルのタグは上書きでも変わらない**。
既定タグは機械ごとに違う（実機は `1041` / PUB400 は `850`）ので、
**中身が UTF-8 でも嘘のタグが付く**（`20260801-ifs-write-dataccsid`）。
置いたファイルは `finally` で消す。

`research-call-program.mjs` — **プログラム呼び出し（`host_call_program`）の正常系**。
`QUSROBJD`（`OBJD0100`）と `QSYRUSRI`（`USRI0100`）を正しいパラメータ列で呼び、
**返った中身を外部の事実と突き合わせる**（「エラーが出ない」だけでは間違った位置を
読んでいても気づけない）。出力が**要求順**に返り、入力の位置が `null` になることも見る。
文字列は **EBCDIC・右空白詰めの固定長**、長さは 4 バイト、
**エラーコード構造の先頭 4 バイトは 0**（非 0 にするとメッセージが出なくなる）。
副作用なし（`20260801-call-program-realhost`）。

`research-pure-dbcs-lob.mjs` — **純 DBCS の DBCLOB（CCSID 300）の実測**。
ロケーター経由とインラインの両方で、中身・`byteLength`・申告長（**文字数**）を確かめる。

> ⚠ **純 DBCS の列はジョブの CCSID から直接作れない**（`-332/57017`＝変換が無い）。
> **1200 を経由する二段キャスト**なら通る:
> `CAST(CAST('日本語' AS DBCLOB(1K) CCSID 1200) AS DBCLOB(1K) CCSID 300)`。
> `16684` はこの実機では 1200 経由でも通らなかった（`20260801-pure-dbcs-dbclob`）。

`verify-printer-residency.mjs` — **プリンター常駐の通し確認**。
出力設定つきで開く → **購読を外す（ブラウザを閉じた状態）** → スプールを流す →
**帳票を受信して PDF が保存される**ところまで見る。

> ⚠ **ライターは自動では上がらない**——プリンターセッションを繋いだだけでは
> スプールが `READY` のまま溜まる。`STRPRTWTR` が要る。
> **前の実行の残骸が装置を掴む**と何も届かないので、開始時に `ENDWTR` ＋ `CLROUTQ` する
> （＝**そのキューのスプールを消す**。共有装置では注意）。
> 用紙タイプはずらさない（ずらすと MSGW で止まる。それを狙うのは `research-msgw.mjs`）。

`measure-printer-residency-long.mjs` — **常駐プリンターの長時間耐性と上限の実機確認**。
`REPORT_LIMIT`(50) を越えるまでスプールを流してから、**アイドルを挟んで届き続けるか**を見る。

> ⚠ **アイドルの間は何も送らない。** 定期的に叩くと「使い続けていれば保つ」しか分からない。
> 2026-08-22 の実測: 55 件投入 → **保持 50 / 累計 55 / PDF 55**（落ちた分も PDF には残る）。
> **15 分のアイドル後は帳票が届かなかった**——その原因を詰めるのが次のスクリプト。

`measure-printer-idle-drop.mjs` — **接続がアイドルでいつ落ちるかの特定**。
`entry.state` を**受動的に**見るだけで、⚠ **プリンター接続には何も送らない**
（送るとアイドルそのものを崩す）。`listening → reconnecting/error` に変わった時刻が答え。

> これで「接続が落ちている」のか「接続は生きていて別のところで止まっている」のかが割れる。
> **`tn5250` / `vt` / `tn3270` の TCP にキープアライブが無かった**のが原因で、
> `hostserver` 側（待ち行列監視が使う）には入っていた——**入っていない方だけが落ちていた**。

`diag-printer-idle-cause.mjs` — **アイドル明けに届かない理由の切り分け**。
⚠ **症状が同じでも原因は 2 つある**——(A) こちらのソケットが黙って死んでいる /
(B) ホスト側のライターが終わっている。アイドル明けに**両側を同時に見る**:
`entry.state` と `entry.session`、そして `QSYS2.OUTPUT_QUEUE_INFO` のライター状態と滞留件数。

> **どちらか決めずに直さない**ためのもの。こちら側は 20 分アイドルでも `listening` のままで
> **障害が全く見えない**（キープアライブが無いと無言の死に気づけない）ので、
> ホスト側の口から見ないと割れない。

`diag-3270-idle.mjs` — **3270 がアイドルを越えられるか**（実機）。

> ⚠ **「IBM i は 3270 を受けない」は誤り。** 実機は受ける
> （`.aidev/backlog/tn3270-ibmi.md` / `verify-3270-keys.mjs`）。
> **プリンターが 15 分で死んだのと同じホスト・同じ 23 番**なので、
> VT（pub400・別経路）と違って条件が揃った測定になる。
> ⚠ 生存は**受信イベントの到着**で見る——サインオン画面で Enter を押すと
> **同じ画面が返る**ので、「画面が変わったか」では往復を検知できない（一度測り損ねた）。

`diag-vt-idle-job.mjs` — **pub400 の VT がアイドルで死ぬ理由の切り分け**。
⚠ **VT のソケットには触らない**（触るとアイドルが崩れる）。装置名を控えて、
**別のホストサーバー接続から**対話ジョブの生死を 60 秒ごとに見る。
ジョブが消えるなら A（ホストが終わらせた）、生きているのに届かないなら B（接続だけ死んだ）。

> 分かっていること（2026-08-22・すべて pub400・同じ 23 番・キープアライブ有効）:
> **5250 表示は 30 分を越え、VT はサインオンの有無に関わらず 30 分で黙って死ぬ**。
> どちらの層も定期送信を持たないので両方とも本当にアイドル。
> **経路が落とすなら 5250 も死ぬはず**なので、経路ではない。

`diag-session-idle.mjs` / `diag-vt-idle.mjs` — **表示セッション・VT がアイドルを越えられるか**。
プリンターで見つかった無言死が表示側にも当たるかの確認。生死は
「Enter に応答するか」「送った文字が返るか」で見る。

> ⚠ **ホストの `QINACTITV` と混ぜないこと。** これは**非活動の対話ジョブをホスト側から切る**
> 設定で、掛かった切断は**不具合ではない**。
> **実機は 10 分 / pub400 は 120 分**（2026-08-22 実測）なので、
> **10 分を越える表示セッションの試験は pub400 でしか成立しない**。
> ⚠ プリンターに `QINACTITV` は掛からない（対話ジョブではない）。
> ⚠ VT は **pub400 限定**——実機は交渉まで進むが画面が来ない。

`verify-printer-report-history.mjs` — **閉じている間に届いた帳票の配り直し**。
ブラウザで開く → **WS を切る** → スプールを流す → **開き直して読める**ところまで見る。

> **`WsConnection` を通す**のがこのスクリプトの要点。ほかのプリンター系は
> `SessionManager` を直接叩くが、`20260802-printer-report-history` で壊れていたのは
> **電文の層**（サーバーは `printer-opened.reports` に載せていたのに web-ui が捨てていた）。
> 受け手側は vitest（`printer-report-restore.test.ts`）で、電文側をここで測る。
>
> 見るのは件数だけでなく**受信時刻**——`閉じた < 受信 < 開き直し` が成り立つかを確かめる。
> 開いた時刻で押していると、この不等式が両側とも崩れる。
> 資格情報は `passwordEnv` で env のまま渡し、設定オブジェクトに平文を置かない。

## SQL 画面（SELECT 以外）の検証用資産（実機 / TESTLIB）

| スクリプト | 内容 |
|---|---|
| `build-sqldemo.mjs` | `TESTLIB` に `SQLDEMO*` 一式を作って**残す**（表・ビュー・索引・トリガー・手続き 3 種・関数）。手続きは **OUT パラメーター**・**結果セット 1 個**・**結果セット 2 個**の 3 通りで、SQL 画面の見え方を人が確かめるためのもの。**DDL はこのスクリプトが持ち物**で、SQL 画面へそのまま貼っても通る形で書いてある（複合文をコピーして実行できる）。毎回作り直す（先に DROP する）。 |
| `verify-browser-sql-exec.mjs` | 実ブラウザで SQL 画面を操作する回帰（25 項目）。**自前の `SQLEXEC*` を作って最後に消す**——`DROP` が効くこと自体が検証対象なので、残す資産（上の `SQLDEMO*`）とは名前を分けてある。 |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-sqldemo.mjs    # 検証用資産を作る（残る）
AS400_PASSWORD=... node scripts/verify-browser-sql-exec.mjs
```

作ったあと SQL 画面で試すもの:

```sql
SELECT * FROM TESTLIB.SQLDEMO ORDER BY ID;
CALL TESTLIB.SQLDEMOP(1, 1.50, ?);   -- 出力パラメーター
CALL TESTLIB.SQLDEMORS();            -- 結果セット 1 個
CALL TESTLIB.SQLDEMORS2();           -- 結果セット 2 個（1 個目だけ出る）
CALL TESTLIB.SQLDEMOPICK();          -- その 2 個目（ロケーター経由の雛形）
SELECT ID, TESTLIB.SQLDEMOF(ID) FROM TESTLIB.SQLDEMO ORDER BY ID;
```

> ⚠ **アプリを止めてから実行する。** 起動したままだとプールの接続が表を掴んでいて
> `DROP` が 20 秒で時間切れになり、そこで接続が使えなくなる（スクリプトは理由を出して止まる）。

### 2 個目以降の結果セット

ホストサーバー経由では、手続きが返す結果セットは **1 個目しか開けない**。2 個目を開こうとすると
`SQLCODE -517`（選択ステートメントではない）で断られる。実機で 10 通り試して確認した
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
| `research-visual-explain{,2,3,4,5}.mjs` | 調査（サービスの有無・引数・記録の形・`explain only` の可否・`PROCESS_DETAILED_MONITOR` の探索） |
| `research-visual-explain-pub400.mjs` | 7.5・非特権での挙動（版数と権限の差を切り分ける） |
| `research-visual-explain-compare.mjs` | **同一 SQL** で 7.3 / 7.5 を突き合わせる（`as400` / `pub400` を引数で切替） |
| `research-visual-explain-shapes.mjs` | 結合・集約・副問合せ・UNION で出る記録種別と階層列（`QQQDTN` / `QQQDTL`） |
| `verify-visual-explain.mjs` | 採取の疎通（hostserver の関数を直接。`pub400` 引数あり） |
| `verify-visual-explain-e2e.mjs` | **REST 経由の統合検証**（`buildApp` を通す。`pub400` 引数あり） |

```sh
node --env-file=.env --env-file=.env.verify scripts/verify-visual-explain-e2e.mjs          # 実機 (7.3・全特権)
node --env-file=.env --env-file=.env.verify scripts/verify-visual-explain-e2e.mjs pub400   # PUB400 (7.5・特権なし)
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
  `SELECT * FROM TESTLIB.M_MENUTR T1 INNER JOIN …` のようなリテラルの無い実文で
  利用者が踏んだ。`verify-visual-explain.mjs` は**リテラルの無い文**も必ず通す。

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
| `research-pcml.mjs` | `CRTBNDRPG … PGMINFO(*PCML) INFOSTMF('/…')` が**実機で通るか**を測り、吐かれた PCML を採る。試験片 `TESTLIB/PCMLTST` もここで作る |
| `research-pcml-layout.mjs` | **宣言どおりのバイト並びで実機が受け取るか**を、生バイトで組んで測る（構造体＝連結／配列＝反復の確認） |
| `verify-pcml.mjs` | 同じ往復を**名前だけ**で行う（手詰めが消えたことの確認）。記述は IFS から読む |
| `verify-browser-pcml.mjs` | 実ブラウザ（Playwright）で PCML ペインを操作。読み込み・入れ子の描画・呼び出し・結果の表示・断り方まで |

実測（実機）で確かめたこと:

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
| `verify-pcml-api.mjs` | IBM の `qsyrusri.pcml` のまま QSYRUSRI を呼び、返った値を **QSYS2.USER_INFO と突き合わせる** |
| `verify-browser-pcml-api.mjs` | 実ブラウザで IBM の記述を貼り付けて呼ぶ。予約域の見え方と `outputsize` の断り方まで |

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
| `verify-pcml-dynamic.mjs` | IBM の `RUser.pcml`（`USRI0300`）を呼び、**ホームディレクトリを QSYS2.USER_INFO と突き合わせる** |
| `verify-browser-pcml-dynamic.mjs` | 実ブラウザで同じことをする。件数が出力で決まる行の見せ方まで |

実測（実機 / `USRI0300`）:

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

## 3270 で IBM i に繋いだときのキー

⚠ **IBM i では 3270 の `PFn` は F キーではない。** 出典は IBM i 自身の
「ヘルプ－ 3270 キーボード・マッピング」画面（3270 で繋いで **`PF2`**）:

```
PF1  5250 ヘルプ・テキスト      PF7  前ページ・キー
PF2  3270 ヘルプ・テキスト      PF8  次ページ・キー
PF3  **画面の消去**            PF9  アテンション
PF4  画面の印刷                PF10 取り消し
PF5  表示属性                  PF11 システム要求
PF6  テスト要求                PF12 レコード後退
PF13〜PF24 → F13〜F24

PA1 PF1..PF12 → F1..F12        PA2 PF1..PF12 → F13..F24
```

| スクリプト | 内容 |
|---|---|
| `verify-3270-keys.mjs` | 実機で F3 / F4 / F12 / F13・ページ送り・Help / Print / SysReq / Attn が効くことを確かめる（14 項目）。**`PROBE=PUB400` で pub400 にも当たる**（画面が英語なので目印は両対応） |
| `verify-browser-3270-keys.mjs` | 実ブラウザで F4 / F12 が効くことを確かめる |

**2 台の IBM i で確かめた**（社内機 V7R5M0 ／ pub400）——どちらも **14 PASS / 0 FAIL**。
装置名では 2 台の答えが割れたので、キーの対応表も両方に当てている。

実測:

- `PA1` を送ると**施錠される**。解けるまで **31 ミリ秒**。待ってから `PFn` を送る
- **F13〜F24 は素の `PF13`〜`PF24`** で足りる（`PA2`+`PF1` と同じ画面が出た）
- **IBM i は `DO TN3270E` を出さない**。見分けには使えない
- **IBM i は `DO NEW-ENVIRON` を出す**（TK4- / z/OS は出さない）。これが見分け

⚠ **ページ送りを F7 / F8 として送ってはならない。** IBM i の `PF7` / `PF8` は
「前ページ・キー / 次ページ・キー」そのもの。F7 として送ると `PA1` が前置されて別のキーになる。

⚠ **3270 の画面の文字は `innerText` に載らない。** 各桁は `<input>` の値なので、
実ブラウザの検証では**値も集める**こと（2 回踏んだ）。

⚠ **キーが効いたかを先頭行で判定しない。** `SysReq` は 24 行目に入力行を出すだけで
先頭行は変わらず、ヘルプは*窓*で重なるので先頭行が元のまま。**画面全体で突き合わせる**こと。
実測で効いた形:

| キー | 社内機（日本語） | pub400（英語） |
|---|---|---|
| Help (PF1) | 「IBM I メインメニュー－ヘルプ」の窓 | `Help — IBM i Main Menu` |
| Print (PF4) | 「印刷操作が完了した。」 | `Print operation complete to the default printer` |
| SysReq (PF11) | 24 行目に入力行 → Enter で「システム要求」 | 同左（`System Request`） |
| Attn (PF9) | 「EVXX01 コマンド入力」 | **`Operational Assistant (ASSIST) Menu`** |

⚠ **Attn で出る画面はシステム次第**（注意プログラム＝`ATNPGM`）。題名で判定せず、
**画面が変わったこと**で見ること。

⚠ **s3270 は社内ホスト相手の物差しに使えない。** docker は開発コンテナの外で動くため
到達できない（`not-connected` になる）。TK4- 相手なら使える。

### 3270 の装置名

IBM i は装置名を **NEW-ENVIRON の `DEVNAME`**（RFC 4777）で受け取る。
端末タイプに `@名前` を付ける方は**交渉が 15 秒で時間切れ**になる。

| 渡し方 | pub400 | 実機 |
|---|---|---|
| 端末タイプに `@名前` | **時間切れ** | **時間切れ** |
| NEW-ENVIRON の `DEVNAME` | **効く**（Display name が要求どおり） | 画面を送らずに接続を閉じる |

⚠ **受け入れるかはホストの設定次第。** 同じ要求に 2 台が違う答えを返す。
仕組みが無いのではなく、**断るホストがある**。断られたときは閉じる理由に装置名を添える
（素の `socket closed` では利用者が装置名に辿り着けない）。

⚠ **1 台の測定を一般化しない。** 社内機だけを見て「IBM i は装置名を受け付けない」と
結論し、`DEVNAME` を送るのを止める変更を入れかけた。pub400 で測り直したら通った——
そのまま出していたら**効いていたホストを壊していた**。

⚠ **「画面が届いたか」はレコードの有無では見分けられない。**
装置名を断るホストも、閉じる前に構造化フィールドの問い合わせを 1 つ送ってくる。

⚠ **TN3270E は使えない。** `DO` を待つだけでなく**こちらから `WILL TN3270E` を出しても
2 台とも `DONT`** で返る（TLS の 992 番も閉じている）。だから 3270 本来の
`CONNECT` による装置名は使えず、`DEVNAME` が唯一の道。

| スクリプト | 内容 |
|---|---|
| `verify-3270-devname.mjs` | 装置名が使われるか／断られるなら理由が出るかを確かめる（`PROBE_HOST` で相手を替えられる） |

**メインフレーム側（`@名前`）は TK4- の E2E で覆っている**:

```sh
sh packages/tn3270/test/harness/testenv.sh up
TN3270_E2E=1 npx vitest run --root packages/tn3270
```

⚠ `terminalTypeFor({ deviceName })` で**名前を埋めた文字列を渡す**試験だけでは、
`TelnetLayer` が自分で `@名前` を付ける道を通らない。そちらは
「IBM i には付けない」という条件を持つので、**付ける側**を実ホストで直接見る試験を足してある
（`e2e-negotiation.test.ts`。送ったバイトに `@03C0` が載ることまで確かめる）。

### 実機に任意の 5250 コマンドを発行させる

**「実機で届かないから確かめられない」は誤りだった。** IBM 自身が 5250 コマンドを発行する
API を出荷している——**動的画面管理（DSM）**。`QSYSINC/H(QSNAPI)` に手続きが揃っており、
**任意のコマンドバイトを出す口もある**。

| スクリプト | 内容 |
|---|---|
| `build-dscmd.mjs` | `scripts/host-src/dscmd.c` を IFS へ置き `CRTBNDC`（`TESTLIB/DSCMD`） |
| `diag-5250-commands.mjs` | 5250 セッションから `CALL` し、**送受信の生バイト**とホスト側のログを見る |
| `build-rdimm.mjs` / `diag-read-immediate.mjs` | 0x72 専用（先に作った方。`dscmd` に統合してある） |

```sh
node --env-file=.env --env-file=.env.verify scripts/build-dscmd.mjs
node --env-file=.env --env-file=.env.verify scripts/diag-5250-commands.mjs ROLLUP ROLLDOWN READIMM READIMMALT PRTSCR BADCMD
# 片付け: DLTPGM TESTLIB/DSCMD ＋ /tmp/dscmd.c /tmp/dscmd.log
```

| 要求 | API | 届くバイト |
|---|---|---|
| `ROLLUP` / `ROLLDOWN` | `QsnRollUp` / `QsnRollDown` | `04 23 03 02 14` / `04 23 83 02 14` |
| `READIMM` | `QsnReadImm` | `04 72` |
| `READIMMALT` | `QsnReadMDTImmAlt` | `04 83` |
| `PRTSCR` | `QsnPutInpCmd(0x66, …)` | `04 66` |
| `BADCMD` | `QsnPutOutCmd(0xFE, …)` | `04 fe` |

**`QsnPutInpCmd` / `QsnPutOutCmd` は第 1 引数がコマンドバイトそのもの**なので、
ここに無いコマンドも同じやり方で出せる。結論は `.aidev/backlog/datastream-commands.md`。

⚠ **`CRTBNDC` は失敗しても戻りコード 0 で返ることがある**（`CZM1613 The compilation failed.` が
診断メッセージ止まり）。**「OK」を信じず `CHKOBJ` で物を確かめること。** 一度これで
「プログラムが見つからない」まで気づかずに進んだ。**失敗時はメッセージを投げる前に出す**
（投げてから出すと中身が見えないまま落ちる。これも踏んだ）。

⚠ **`Q_Bin4` も `Q_Handle_T` も `long`。** `int` で受けると `CZM0280`、
ハンドルに `NULL` を渡しても `CZM0280`。`0` を渡す。

⚠ **DSM の引数は必ずヘッダーで確かめる。** `QsnRtvDta` を 5 引数だと思って書いて落とし、
`QsnRollUp` の並びを `(上端, 下端, 行数)` だと思って `CPFA315` で落とした
（正しくは `(行数, 上端, 下端)`。**エラーメッセージの本文が並びを教えてくれる**）。

⚠ **C ソースをテンプレート文字列に埋めない。** エスケープが二重になって型の直しが効かなかった。
`scripts/host-src/` に実ファイルで置く。

⚠ **`fopen` を IFS へ向けるには `SYSIFCOPT(*IFSIO)`** が要る（既定はレコード・ファイル）。

## VT（文字モード端末）

**5250 / 3270 と根本的に違う。** ブロックモードではなく文字モード——フィールドも MDT も AID キーも
無く、1 打鍵ごとにバイトを送ってホストのエコーで画面が変わる。

| スクリプト | 内容 |
|---|---|
| `verify-vt-linux.mjs` | docker の telnetd 相手に実アプリで確かめる（22 項目。`vi` の代替画面・`less` のページ送り・256 色/24 ビット色・日本語の 2 桁占有・NAWS のリサイズ・`tmux` との突合） |
| `verify-vt-ibmi.mjs` | IBM i に VT で繋いでサインオン → メインメニュー → `DSPLIBL` → サインオフ（9 項目。`PROBE=AS400` で社内機） |
| `verify-browser-vt.mjs` | **実ブラウザ**で VT ペインを通す（22 項目。Linux 相手。コマンドの往復・色・日本語・IME・`vi`・履歴・リサイズ・5250 の道具を出さないこと） |
| `verify-browser-vt-ibmi.mjs` | **実ブラウザ**で IBM i に VT サインオン（UI 経路でもコードページの申告が効いているか） |
| `diag-vt.mjs` | **画面が来ないホストの原因をホスト側から追う**（サブシステムのジョブログ・装置の種類・サインオン画面。読むだけ） |
| `capture-vt-trace.mjs` | 実バイト列を JSONL に採る（`packages/vt/test/fixtures/`）。**IBM i はサインオン画面までで採り終える**ので資格情報が入らない |

⚠ **VT の画面文字は `innerText` で取れる**（span で描くため）。5250 / 3270 は `<input>` の
value に入るので取れない——**ペインごとに違う**ことを忘れない。

### Linux 側の検証環境

```sh
docker build -t ts5250-vt-telnetd scripts/vt-telnetd
docker run -d --name ts5250-vt -p 2331:23 ts5250-vt-telnetd
node scripts/verify-vt-linux.mjs
docker rm -f ts5250-vt
```

**ポートは 2331**。2323 は同じホストの別プロジェクトが使っていた（実測）。

### IBM i の VT で踏むところ

⚠ **`CPF1120` は VT でも出る。原因も対処も 5250 / 3270 と同じ。**
NEW-ENVIRON で `KBDTYPE` / `CODEPAGE` / `CHARSET` を申告しないと、ホストがシステム既定の
コードページで装置を作り、記号入りのパスワードが化ける。pub400 は `QCCSID=273`（ドイツ語）なので
無申告だと必ず落ちる。`ccsid` を渡せば `deviceEnvFor` が引いて申告する。

⚠ **端末タイプは `VT220` を申告する。** `xterm-256color` を出すと IBM i は知らないので
`SB TERMINAL-TYPE SEND` を**繰り返してくる**（実測）。`VT100` / `VT220` は 1 回で受ける。

⚠ **打鍵を一括で流すと取りこぼす。** サインオン画面に `ユーザー名 TAB パスワード CR` を
一度に送ると欄の移動が間に合わずパスワードが入らない。`VtSession` は IBM i と判定したら
**1 文字ずつ 20ms 空けて**送る（利用側は意識しなくてよい）。

⚠ **ホストによっては画面が来ない。1 台で一般化しないこと。**

| | pub400 | 実機 |
|---|---|---|
| VT の交渉 | 通る | 通る |
| **サインオン画面** | **来る** | **来ない**（生 43 B ＝ 交渉のみ） |
| QAUTOVRT | 32767 | **200**（自動作成は有効） |
| QMAXSIGN | 5 | **3** |
| サインオン画面 | `QSYS/QDSIGNON`（**英語**） | `QSYS/QDSIGNON`（**日本語**） |

### 実機で来ない理由（2026-08-22 に確定）

`diag-vt.mjs` でホスト側の連鎖を追い切った。

1. `QTVDEVICE`（TELNET の装置管理）が仮想装置を **`TYPE(V100) MODEL(*ASCII) KBDTYPE(USB)`**
   で作ってオンにする
2. サブシステム（QBASE）が割り振り、サインオン画面 `QSYS/QDSIGNON` を開こうとする
3. **`CPF5553 漢字文字セット装置が必要となることがある`** → `CPF5511`（ファイル・パラメーターの
   正しくない組み合わせ）→ `CPF1398` → `CPF1194`（装置をオフに構成変更）→ 1 に戻る

**日本語の IBM i ではサインオン画面の DDS が日本語の定数で書かれている**——
`QGPL/QDDSSRC(QDSIGNON)` に `'サイン・オン'` `'システム. . . . :'` 等がそのまま入っている。
**DBCS 定数を含む表示ファイルは漢字装置を要求する**が、**VT の装置は必ず ASCII** で作られる。

⚠ **クライアント側では直せない。** 実測で確かめた:

| 試したこと | 結果 |
|---|---|
| 端末タイプ VT220 / VT100 / xterm | どれも画面なし |
| RFC 2877 で `JKB`/290/1172（日本語）を申告 | 装置は **`KBDTYPE(USB) MODEL(*ASCII)` のまま** |
| RFC 2877 で `USB`/37/697 を申告 | 同上 |
| 申告なし | 同上 |
| `DEVNAME` で装置名を要求 | **使われない**（その名前の装置は作られない） |

**RFC 2877 の申告は 5250 / 3270 の仕組みで、VT の装置には効かない。**

### 直すならホスト側（**未実施**。構成を変えるので判断が要る）

英語（非 DBCS）のサインオン画面は**既にホストに在る**——`QSYS2924/QDSIGNON`
（2924 = 英語・大小文字）。

- **A: サブシステムのサインオン画面を差し替える**
  `CHGSBSD SBSD(QSYS/QBASE) SGNDSPF(QSYS2924/QDSIGNON)`
  1 コマンドで戻せるが、**5250 を含む全員のサインオン画面が英語になる**。
  反映に QBASE（制御サブシステム）の再始動が要るかは未確認。
- **B: ASCII 装置だけ別のサブシステムに寄せる**（5250 に触らない）
  `ADDWSE` の `WRKSTNTYPE` は **`*ASCII` / `*NONASCII` を受ける**（コマンド定義を実機で確認）。
  VT の装置は `MODEL(*ASCII)` なので**種類で切り分けられる**。
  サブシステムを 1 つ起こし、`SGNDSPF(QSYS2924/QDSIGNON)` と `WRKSTNTYPE(*ASCII) AT(*SIGNON)` を
  与え、QBASE 側には `WRKSTNTYPE(*ASCII) AT(*ENTER)` を足して拾わせない。
  **影響は VT だけ**だが、サブシステム記述・経路指定・ジョブ待ち行列を作る作業になる。

### B を実際に当てた結果（2026-08-22。**適用して確かめ、戻した**）

`setup-vt-subsystem.mjs apply` を実機に当てた。**1 枚目の壁は破れた。**

- `TESTLIB/VTSBS`（`SGNDSPF(QSYS2924/QDSIGNON)`・`WRKSTNTYPE(*ASCII) AT(*SIGNON)`）を起こし、
  QBASE に `WRKSTNTYPE(*ASCII) AT(*ENTER)` を 1 行足した
- **画面が届くようになった**——英語のサインオン画面が出て `Subsystem . . : VTSBS` と表示される。
  `CPF1194` のループは止まった
- **サインオンも通り、対話ジョブが起動した**（`CPF1124 サブシステム VTSBS のジョブ
  121774/***/QPADEV000B が開始された`）

**ただし 2 枚目の壁があった。小文字が `-` に落ちる。**

```
                                   S--- O-          ← "Sign On"
                       S-------- . . . . :   VTSBS  ← "Subsystem"
```

`QCHRID = 1172 / 290`——**日本語カタカナの EBCDIC で、小文字が存在しない**。VT の仮想装置は
`CHRID(*SYSVAL)` でこれを継ぐので、英語（697/37）の画面を送る途中で小文字が落ちる。
CCSID の申告を 37 に変えても同じ（装置側の話なので効かない）。

→ **日本語 IBM i を VT で使うのは現実的でない**と判断し、**戻した**
（`rollback`。QBASE のワークステーション項目は `*ALL`/`*CONS`/`5555` の元の姿に復帰、
`TESTLIB` に残り物なし、3270 の疎通も確認済み）。

さらに解くなら `QIBM_QTG_DEVINIT`（TELNET の装置初期化出口）で装置の `CHRID` を英語系に
するのが IBM の口だが、**検証用途には見合わない**。IBM i 相手の VT 検証は pub400 で足りる。

⚠ **これは実機の設定漏れではなく、日本語 IBM i の構造**（`QLANGID(JPN)` の機械は
サインオン画面が日本語＝DBCS）。ただし**測ったのは日本語カタカナ系 1 台と英語系 1 台だけ**で、
「日本語 IBM i なら共通」は機構からの推論。JEB 系（コードページ 1027・小文字あり）なら
2 枚目の壁は無いはず。

⚠ **サインオンの失敗は QMAXSIGN に数えられる。** 実機は 3 回。試行を重ねない。
