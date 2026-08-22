# 5250 データストリームの未実装コマンド

`wtd-applier.ts` の `default` 節は**未知のコマンドでレコードの残りごと捨てる**。
パラメータ長が分からない以上それは妥当だが、**捨てた後ろに READ があると入力待ちに入り、
利用者には「待機中・ホストから応答がない」としか見えない**。

この形で 3 回踏んでいる:

- `SAVE SCREEN`（0x02）に応答せず、SEU の F1 ヘルプが 30 秒返らなかった
- `WRITE ERROR CODE TO WINDOW`（0x22）未処理で、同じレコードの READ ごと捨てた
- **`SAVE PARTIAL SCREEN`（0x03）未処理で QSH が固まった**（2026-07-30・
  `20260730-qsh-save-partial-screen`。実測は `scripts/diag-qsh-osaka.mjs`）

## 実機で数えた（2026-07-30・`20260730-datastream-command-census`）

`scripts/census-5250-commands-osaka.mjs` で SR-OSAKA の**読み取り専用の画面 11 件**を巡り、
届いたコマンドを数えた（`STRSQL` / `DSPMSG` / `WRKACTJOB` / `WRKSYSSTS` / `DSPJOBLOG` /
`WRKSPLF` / `DSPLIBL` / `WRKOBJ` / `STRPDM` / `GO CMDIFS` / `QSH`。各画面で PageDown/PageUp も送信）。
**83 レコード中、未知のコマンドは 0 件。**

| コマンド（レコード先頭） | 回数 |
|---|---|
| `CLEAR_UNIT`(0x40) | 50 |
| `WRITE_TO_DISPLAY`(0x11) | 17 |
| `SAVE_PARTIAL_SCREEN`(0x03) | 2 |
| `WRITE_STRUCTURED_FIELD`(0xf3) | 1 |
| `RESTORE_PARTIAL_SCREEN`(0x13) | 1 |

## 数え直した（2026-08-22・20 画面／142 レコード・`20260822-datastream-census-2`）

前回は 11 画面 83 レコード。**backlog の指示どおり census を再実行**し、
`ROLL` と `READ IMMEDIATE` を届かせにいくために画面を 9 つ足した
（`GO ASSIST` / `DSPPFM` / `WRKMBRPDM` / `DSPOBJD` / `WRKUSRJOB` / `GO MAIN` /
`DSPSYSVAL` / `WRKCFGSTS` / `STRS36`）。

| コマンド（レコード先頭） | 回数 |
|---|---|
| `CLEAR_UNIT`(0x40) | 109 |
| `WRITE_TO_DISPLAY`(0x11) | 16 |
| `WRITE_STRUCTURED_FIELD`(0xf3) | 2 |
| `SAVE_PARTIAL_SCREEN`(0x03) | 2 |
| **`RESTORE_SCREEN`(0x12)** | 1 |

- **未知のコマンドは 0 件**（142 レコード中）。実装は今のところ取りこぼしていない
- **`ROLL`(0x23) は今回も届かなかった**
- **`READ IMMEDIATE`(0x72) も届かなかった**
- 前回は `RESTORE_PARTIAL_SCREEN`(0x13) が 1 件、今回は **`RESTORE_SCREEN`(0x12) が 1 件**。
  どちらも実装済みなので実害は無いが、**回によって出る方が変わる**

### ⚠ System/36 の仮説は「潰した」のではなく「**この機械では試せない**」

`ROLL` の候補として backlog が挙げていた System/36 環境を試したが、**`STRS36` を実行しても
メインメニューに戻るだけ**だった。調べると SR-OSAKA には S/36 環境が入っていない:

| | |
|---|---|
| `QSYS/STRS36`（CMD） | **無い** |
| `QSYS/STRS36PRC`（CMD） | **無い** |
| `QSSP`（LIB） | **無い** |
| `5770WDS` option 32（S/36 互換 RPG II コンパイラ） | 在る（**コンパイラだけ**。実行環境ではない） |

**S/36 環境のある機械が要る。** ここで「候補ではなかった」と結論してはいけない。

### census スクリプトが動かなくなっていた（直した）

`connections.json` だけを見ていたが、SR-OSAKA の定義が `profiles.local.json`（サーバー設定）へ
移っており、**`Cannot read properties of undefined` で落ちていた**。両方を見るようにした。
**設定の置き場が 2 つある以上、片方だけを見る補助スクリプトは黙って壊れる。**

## 確認済み

- [x] **RESTORE PARTIAL SCREEN（0x13）は届く**——**QSH を F3 で抜けるとき**
  - 中身は**こちらが `0x03` の応答で送った保管物そのもの**:
    `04 13 | 00 00 00 00 00 | 04 11 …（WTD）| … 04 52 …（READ）`
  - **不備が 1 件見つかって直した**: パラメータ 5 バイトを読み飛ばしておらず、
    続きを ESC と読み違えて `expected ESC, got 0x0 — discarding rest of record` で
    **ホストが返した画像と後続の READ を捨てていた**
    （F3 直後に別レコードで描き直されるため症状としては見えていなかった）

## 原典で確定した（2026-07-30・`20260730-tn5250-cross-check`）

tn5250（C）と tn5250j（Java）の該当実装を読み、当方と 1 つずつ突き合わせた。
**2 実装が一致した点だけを確定として扱う**。

- [x] **`ROLL`(0x23) の方向ビット** — **当方が逆だった（バグ）。直した**
  - `0x80` **落ち＝上へ / 立ち＝下へ**（tn5250 `session.c`＋`dbuffer.c` と
    tn5250j `Screen5250.rollScreen` のコメントが一致）
  - 行数は下位 5 ビット（tn5250j は `& 0x7f` だが 32 以上は画面を超えるので差が出ない）
  - ⚠ **実機では依然として未確認**（送ってくる画面が見つかっていない）
- [x] **`SAVE PARTIAL SCREEN`(0x03) のパラメータ 5 バイトの意味**
  - **フラグ・上端行・左端桁・窓の深さ・窓の幅**（tn5250 `session.c`）。
    ただし**原典も値を使っていない**（読み捨てて画面全体を返す）。実機は全て `00`
- [x] **`RESTORE PARTIAL SCREEN`(0x13) はパラメータを持たない**
  - 原典は 1 バイトも読まずに無視する（「後続は WTD のはず」）
  - 当方が 5 バイト読んでいたのは**自分の応答に写しを埋め込んでいたから**——
    ホストは積荷をそのまま返すので、自分が付けたものを誤解していた（自作自演）。
    **応答を `ESC 12 ＋ WTD`（SAVE SCREEN と同一）に揃えて解消**
- [x] **`READ SCREEN TO PRINT`(0x66/0x68/0x6A/0x6C) / `READ IMMEDIATE`(0x72/0x83) は
  パラメータを持たない** — 原典が読まずに無視していることで確認
  - **「レコードごと捨てる」から外した**（後続の READ を失わない）
  - ⚠ `0x72`/`0x83` は本来**応答が要る**。当方は応答していない（警告で明示）

## 未実測のまま（この範囲では届かなかった）

**11 画面では 1 件も届かなかった**ので、実装は増やさない（形式を推測で書かない方針のまま）。
数え直す前に上記の census を再実行すること。

**2026-08-22 に数え直した（20 画面／142 レコード。`20260822-datastream-census-2`）。結果は同じ——1 件も届かない。**
よって**方針は据え置き**（この日の作業では実装を足していない）。次に疑うなら
**S/36 環境のある機械**（SR-OSAKA には入っていない。上節）。

- [ ] **ROLL（0x23）**
  - 実装は入っている（`方向＋行数(1) 上端(1) 下端(1)`。SC30-3533 / tn5250 の定義）が**未実測**
  - 流れる画面（`DSPJOBLOG` / `WRKACTJOB` / `STRSQL` / `QSH`）でも、
    ホストは `CLEAR UNIT` ＋ `WTD` で**描き直していた**
  - どの画面が使うのかは依然として不明。System/36 環境や古いアプリが候補と見られる
  - **2026-08-22: 古いアプリ側は空振り**（`GO ASSIST` / `DSPPFM` / `WRKMBRPDM` / `DSPOBJD` /
    `WRKUSRJOB` / `GO MAIN` / `WRKCFGSTS`。どれも `CLEAR UNIT` ＋ `WTD` で描き直す）
  - **S/36 環境は SR-OSAKA では試せない**（`STRS36` も `QSSP` も無い）。**別の機械が要る**
- [x] **`READ IMMEDIATE`(0x72) の応答** — **実装した**（`20260822-read-immediate` / PR #347）
  - ~~原典の実装は「MDT の有無に関わらず**全フィールドを即送信**」~~
    **← この要約は不正確だった。** 原典を読み直すと**門番がある**:

    ```c
    case CMD_READ_IMMEDIATE:
        if (tn5250_dbuffer_mdt(dbuffer)) {   // ← 画面単位の MDT。立っていなければ欄を 1 つも送らない
            do { tn5250_session_send_field(...); } while (...);   // 欄ごとの MDT は見ない
        }
    ```

    正しくは「**画面のどこかが変更されていれば全ての欄**を送る／変更が無ければ
    **行・桁・AID(0) だけ**」。`master_mdt` は「MDT の立った欄が 1 つでもあるか」と同値
    （`field.c` の `tn5250_field_set_mdt` と同時に `tn5250_dbuffer_set_mdt` が呼ばれる）
  - **tn5250j との突き合わせで分かったこと**: tn5250j は **`0x72` を扱わず**、
    `0x83`（READ MDT IMMEDIATE ALT）だけを実装している。**矛盾ではなく別のコマンド**——
    名前どおり `0x83` は MDT の欄だけを送る（`sf.mdt` で絞る）。
    **2 実装が一致するのは**「`masterMDT` が門番」「待たずに即送信」
    「レコードの opcode は PUT_GET」の 3 点で、実装したのはその範囲
  - ⚠ tn5250j の `readImmediate` は**行・桁・AID の前置きを書いていない**
    （同クラスの `sendAidKey` は書いている）。手落ちと見て tn5250 側に合わせた
  - **実機で裏を取った**（2026-08-22・SR-OSAKA / IBM i 7.3）。通常の画面では届かないが、
    **IBM 自身が 0x72 を発行する API を出荷している**——動的画面管理（DSM）の `QsnReadImm`
    （`QSYSINC/H(QSNAPI)` に `#define QSN_READ_IMM 0x72`）。**IBM の一次資料で opcode が確定**し、
    かつ**発行させる手段になる**。C プログラムを実機に置いて呼んだ:

    ```
    受信  12B  04 72                       ← パラメータ無し
    送信  34B  14 07 00 11 14 07 c3c1d3d3  ← 行20 桁7 AID=0x00 ＋ SBA(20,7) ＋ "CALL…"
    ホスト  QsnReadImm rc=21 bytesRead=21 fdbk_bytes=0   ← エラー無しで受理
    ```

    送った 24 バイトのうち**欄データ 21 バイトをホストが受け取っている**。
    直前の Enter が `AID=0xf1` なのに対しこちらは `0x00`——**原典どおり**。
    資材は `scripts/build-rdimm-osaka.mjs` / `scripts/diag-read-immediate-osaka.mjs` /
    `scripts/host-src/rdimm.c`
- [ ] **`READ IMMEDIATE ALT`(0x83) の応答** — **入れていない**
  - **2 実装で扱いが割れている**（tn5250 は無視、tn5250j は MDT の欄だけ送る）うえ、
    tn5250j 側は前置きを書いておらず倣うのが危うい。実機で届いたことも無い
  - 届いたら警告を出す（`READ IMMEDIATE ALT (0x83) — 応答していない…`）
- [ ] `READ SCREEN TO PRINT` 系（0x66 / 0x68 / 0x6A / 0x6C）の**応答**——届かなかった
  - 原典も未実装（無視）。印刷要求なので、実装するなら画面イメージを印刷経路へ回すことになる
- [ ] **未知のコマンドに対する負応答**
  - 原典は 2 つとも**ホストへエラーを返す**（tn5250: `TN5250_NR_INVALID_COMMAND` /
    tn5250j: `sendNegResponse(NR_REQUEST_ERROR, …)`）。当方は警告して捨てるだけ
  - 入れていないのは**負応答の形式を実機で確かめられない**ため
- [x] **SAVE PARTIAL SCREEN のパラメータ 5 バイトの意味**
  - **上の「原典で確定した」に同じ項目がある**（`20260730-tn5250-cross-check` / PR #223）。この行は重複。
    ~~意味は**未解明**~~ → **フラグ・上端行・左端桁・窓の深さ・窓の幅**（tn5250 `session.c`）。
    ただし**原典も値を使わない**（読み捨てて画面全体を返す）
  - 実機はすべて `00`。**その写しが `0x13` で返ってくる**
  - 現状は解釈せず写して返す（ホストにとって不透明な保管物なので実害は無い）
  - ~~⚠ **読み飛ばす長さ 5 は「こちらが送った形」に依存**している。
    別の長さで `0x13` を送るホストがあれば崩れる（未確認）~~
    **← 解消済み**。`0x13` は原典どおり**1 バイトも読まなくなった**
    （`packages/core/src/protocol/wtd-applier.ts:143-152`）。
    5 バイト読んでいたのは自分の応答に写しを埋め込んでいたためで、その前置きを外した

## その他

- [x] 装置名が使用中で接続を断られるとき、`expected ESC, got 0xc0 — discarding rest of record`
  が出る。5250 のレコードでないものを読んでいる（ホストが閉じる前に何か送っている）。
  ~~**接続はどのみち失敗する**ので実害は無い~~ **← 実害はあった**
    → `20260802-device-busy-record`（PR #292）で解消。
  - **正体は失敗の起動応答**（RFC 4777 §10）。実機 SR-OSAKA が 73 バイトで
    `8902 Device not available.` を返しており、**装置名の欄は空白**（割り当てられていないので当然）。
    ヘッダーを剥いだ先頭に来るのが `ESC(0x04)` ではなくヘッダーの続き `0xc0`
  - **表示セッションだけが取りこぼしていた。** 起動応答の見分けを
    「**装置名が入っているか**」で行っていたため、失敗応答（装置名なし）を
    データストリームとして解析していた。**プリンターは元からコードで見ていて正しかった**
    ——同じ判定が 2 か所にあって片方だけ正しい、いつもの形
  - 直し方は `isKnownStartupCode`（`CODE_MEANING` が唯一の出所）で見分け、
    失敗コードは `SESSION_REJECTED (8902: Device not available.)（装置 AS01）` で断る。
    **`device !== ""` の枝は残す**（今まで通っていたものを落とさない）
  - ⚠ **交渉中にホストが閉じると、閉じた通信路への送信でプロセスが落ちていた**
    （`transport is closed` が `handleSubnegotiation` から飛び、**ソケットのコールバックから
    飛び出して捕まえる相手がいない**）。装置名の重複という日常的な失敗で全利用者が巻き添えになる。
    毎回は起きない（ホストの閉じる速さ次第）。この作業の実機検証で踏んで直した
  - ⚠ **再現には接続条件を実物と揃えること。** 既定（CCSID 37 / 24x80）で繋ぐと
    **起動応答より前**に切られてレコードが届かず、「再現しない」と誤結論しかけた。
    設定どおり（**CCSID 5026 / 27x132**）にすると出る
  - 再現: `scripts/research-device-busy-osaka.mjs`

届いたことに気づけるよう、`unknown command 0x… — discarding rest of record` の警告は残してある。
