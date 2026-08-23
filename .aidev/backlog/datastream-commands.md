---
backlog: datastream-commands
kind: standing
---

# 5250 データストリームの未実装コマンド

`wtd-applier.ts` の `default` 節は**未知のコマンドでレコードの残りごと捨てる**。
パラメータ長が分からない以上それは妥当だが、**捨てた後ろに READ があると入力待ちに入り、
利用者には「待機中・ホストから応答がない」としか見えない**。

この形で 3 回踏んでいる:

- `SAVE SCREEN`（0x02）に応答せず、SEU の F1 ヘルプが 30 秒返らなかった
- `WRITE ERROR CODE TO WINDOW`（0x22）未処理で、同じレコードの READ ごと捨てた
- **`SAVE PARTIAL SCREEN`（0x03）未処理で QSH が固まった**（2026-07-30・
  `20260730-qsh-save-partial-screen`。実測は `scripts/diag-qsh.mjs`）

## 実機で数えた（2026-07-30・`20260730-datastream-command-census`）

`scripts/census-5250-commands.mjs` で実機の**読み取り専用の画面 11 件**を巡り、
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
メインメニューに戻るだけ**だった。調べると実機には S/36 環境が入っていない:

| | |
|---|---|
| `QSYS/STRS36`（CMD） | **無い** |
| `QSYS/STRS36PRC`（CMD） | **無い** |
| `QSSP`（LIB） | **無い** |
| `5770WDS` option 32（S/36 互換 RPG II コンパイラ） | 在る（**コンパイラだけ**。実行環境ではない） |

**S/36 環境のある機械が要る。** ここで「候補ではなかった」と結論してはいけない。

### census スクリプトが動かなくなっていた（直した）

`connections.json` だけを見ていたが、実機の定義が `profiles.local.json`（サーバー設定）へ
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

- [x] **`expected ESC, got 0xc0` の由来** — **データストリームの話ではなかった**
  （`20260802-device-busy-record` / PR #292・`74b317ba`）
  - 正体は**起動応答の失敗コード `8902`（装置が使用中）**。表示セッションがそれを取りこぼし、
    続きをデータストリームとして読んで `expected ESC, got 0xc0` を出していた
  - 症状が解析エラーに見えたのでこの台帳へ積んだが、**原因は交渉段階**だった。
    `PrinterSession.handleStartup` は元からコードで判断していたので、**表示側をそちらへ揃えた**
  - 失敗コードの意味表は `packages/tn5250/src/telnet/startup-record.ts:41`
    （`8902: "Device not available."`。20 件そろっているのに表示だけ辿り着けていなかった）
  - 文言には**要求した装置名を添えた**（`（装置 DEV1）`）——無いとどの装置が使用中か分からない

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

## すべて片づいた（2026-08-22・`20260822-datastream-all`）

**「実機で届かないから確かめられない」という前提が崩れた。**
IBM 自身が 5250 コマンドを発行する API を出荷している——**動的画面管理（DSM）**。
`QSYSINC/H(QSNAPI)` に手続きが揃っており、**任意のコマンドバイトを出す口もある**:

| 出したいもの | API |
|---|---|
| `ROLL`(0x23) | `QsnRollUp` / `QsnRollDown` |
| `READ IMMEDIATE`(0x72) | `QsnReadImm` |
| `READ MDT IMMEDIATE ALT`(0x83) | `QsnReadMDTImmAlt` |
| **任意の入力コマンド** | `QsnPutInpCmd(cmd, …)` ← 第 1 引数がコマンドバイト |
| **任意の出力コマンド** | `QsnPutOutCmd(cmd, …)` |

資材は `scripts/host-src/dscmd.c` / `scripts/build-dscmd.mjs` /
`scripts/diag-5250-commands.mjs`。実機で採ったバイト列は
`packages/tn5250/test/datastream-real-commands.test.ts` に固定した。

- [x] **ROLL（0x23）** — **実機で確定した**
  - `QsnRollUp(行数3, 上端2, 下端20)` → **`04 23 03 02 14`**
  - `QsnRollDown(行数3, 上端2, 下端20)` → **`04 23 83 02 14`**
  - **`0x80` 落ち＝上へ / 立ち＝下へ。** 原典 2 実装から直した向きが**実機で裏づけられた**
    （~~実機では依然として未確認~~）
  - 引数の並びも実測で決まった——`(行数, 上端, 下端)`。`(上端, 下端, 行数)` だと思って渡し
    `CPFA315 ロール・パラメーターが正しくない` で落ちた。メッセージ本文が
    「行数 &1, 最上行 &2, 最下行 &3」と言っている
- [x] **`READ IMMEDIATE`(0x72) の応答** — 実装済み（`20260822-read-immediate` / PR #347）
- [x] **`READ IMMEDIATE ALT`(0x83) の応答** — **実装した**
  - ~~2 実装で扱いが割れているので入れない~~ ← **実機で測ったら固まった。**
    `QsnReadMDTImmAlt` を出させると、こちらは応答待ちで時間切れ、**ホストは API から戻らない**
  - 中身は tn5250j に倣い **MDT の立った欄だけ・AID 0**（名前どおり）。
    実装後は `rc=1 / 欄数=1 / エラー無し` で通った
  - **`bytesRead` の意味が 0x72 と違う**——0x72 は**バイト数**（37）、0x83 は**欄の数**（1）。
    0x83 では `QsnRtvFldCnt` が使え、0x72 では `CPFA32E` で取れない。
    **ALT は欄の構造情報を返す形式**
- [x] `READ SCREEN TO PRINT` 系（0x66 / 0x68 / 0x6A / 0x6C）の**応答** — **実装した**
  - ~~原典も未実装（無視）~~ ← **返さないとホストが固まる**（`QsnPutInpCmd(0x66)` で確認）
  - **画面イメージを返す**（`READ SCREEN`(0x62) と同じ形）。拡張版（0x68 / 0x6C）は
    `READ SCREEN EXTENDED`(0x64) と同じ行区切り形式。実装後は `rc=1024 / エラー無し`
- [x] **未知のコマンドに対する負応答** — **要らないと分かった**
  - `QsnPutOutCmd(0xFE)` で未知コマンドを出させたところ、こちらは警告して残りを捨てただけだが、
    **ホストは `rc=0` で正常に戻り、セッションもそのまま続いた**——**待たない**
  - 原典 2 つは負応答を返すが、**返さなくても止まらない**。形式を確かめられないものを推測で
    送るより、黙って捨てて**警告で気づけるようにする**方を採る（従来どおり）
  - ⚠ 残る危険は「**未知のコマンドの後ろに READ がある**」形。パラメータ長が分からない以上
    捨てるしかない。ただし**読み取り系はこれで全部実装した**ので、その口はかなり狭まった

