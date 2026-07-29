# 実機 E2E / 診断スクリプト

`packages/core` の `Session5250`（および MCP/WS）を実 IBM i（既定 pub400.com）に対して動かす E2E・診断スクリプト。

## 実行方法

ビルド後、資格情報を環境変数で渡して実行する（`.env` は gitignore、パスワードはコミットしない）:

```sh
npm run build
node --env-file=.env scripts/<name>.mjs
```

必要な環境変数: `PUB400_USER` / `PUB400_PASSWORD`（自動サインオン）。任意: `PUB400_HOST`（既定 pub400.com）、
`PUB400_DEVNAME`、`PUB400_LIB`（既定 MYLIB）。各スクリプトは成功で終了コード 0、失敗で 1。

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

```sh
node --env-file=.env scripts/build-adjtest.mjs      # 初回/再作成
node --env-file=.env scripts/verify-browser-adjust.mjs    # E2E（15 項目）
```

注意:
- 実測で分かった要点: **DDS の数値入力欄は `6 0`（ゾーン）も `6S 0` も、ワイヤ上は
  `shift=signed-num`・長さ = 桁数 + 1**（最終桁が符号桁）で来る。素の英数字欄には
  `CHECK(LC)` が無い限り **`MONOCASE` が既定で立つ**。
- 装置名を使い回すため、前回のジョブが残っていると**回復画面から始まる**。
  `verify-browser-adjust.mjs` は回復（90）と前回の `ADJPGM` 残留（F3）の両方を捌く。

## その他

`verify-autosignon` / `verify-signon` / `verify-mcp` / `verify-ws` / `verify-browser` / `verify-dbcs-tls` /
`verify-gui-enhanced`（各機能の実機検証）、`capture-*`（トレース fixture 採取）、
`diag-*`（signon/PDM 診断・`diag-window-fkey` は DDS 窓で無効キーを押したときのホスト応答）、
`dump-screen`（トレースをオフライン再生）も同じ実行規約に従う。

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
