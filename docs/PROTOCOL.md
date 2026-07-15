# PROTOCOL.md — 5250 ワイヤ仕様（他言語移植用）

本書は、この実装（`packages/core`）が扱う **TN5250 / 5250 データストリームのバイトレベル仕様**を集約し、
**他言語でのクリーンルーム再実装**を可能にすることを目的とする。上位契約（画面モデル・MCP ツール・WebSocket）
は `spec.md` を、設計判断の背景は各 `decisions.md` を参照。**バイト一致の検証**は `packages/core/test/fixtures/*.jsonl`
（言語非依存の trace）をリプレイして行う。

参照: RFC 1205（5250 telnet）/ RFC 1572（NEW-ENVIRON）/ RFC 4777（自動サインオン）/ SC30-3533-04 /
GNU tn5250（挙動・バイト仕様の参照。GPL コードは非移植）。数値はすべて 16 進、バイト順はビッグエンディアン。

---

## 1. トランスポート

- TCP。平文は既定ポート **23**、TLS（telnet over SSL）は既定ポート **992**（証明書検証既定 ON）。
- レコード境界は telnet **IAC EOR**（`FF EF`）。

---

## 2. telnet ネゴシエーション

telnet 定数: `IAC=FF`、`SE=F0 SB=FA WILL=FB WONT=FC DO=FD DONT=FE EOR=EF`。
オプション: `BINARY=0 SGA=3 TERMINAL-TYPE=24 EOR=25 NEW-ENVIRON=39`。

- BINARY / EOR / SGA / TERMINAL-TYPE / NEW-ENVIRON を DO/WILL で合意する。
- **SB 本文中の IAC(FF) は二重化**してエスケープ（受信時は逆変換）。

### 2.1 TERMINAL-TYPE（RFC 1091）

ホストの `IAC SB 24 SEND IAC SE`（SEND=1）に対し `IAC SB 24 IS <端末タイプ ASCII> IAC SE`（IS=0）を返す。
端末タイプは接続設定で決定:

| | 24x80 | 27x132 |
|---|---|---|
| SBCS（CCSID 37 等） | `IBM-3179-2` | `IBM-3477-FC` |
| DBCS（CCSID 930/939/1399） | `IBM-5555-C01` | `IBM-5555-B01` |

### 2.2 NEW-ENVIRON（RFC 1572）と RFC 4777 自動サインオン

NEW-ENVIRON 定数: `IS=0 SEND=1 VAR=0 VALUE=1 ESC=2 USERVAR=3`。
ホストの `IAC SB 39 SEND ... IAC SE` に対し、`IAC SB 39 IS <payload> IAC SE` を返す。payload は以下を連結（**文字列は ASCII**）:

1. デバイス名（任意）: `USERVAR "DEVNAME" VALUE <devname-ascii>`
2. 自動サインオン（user/password 指定時。RFC 4777 / tn5250j 準拠）:
   - `VAR "USER" VALUE <user-ascii>`
   - `USERVAR "IBMRSEED" VALUE ESC 00 00 00 00 00 00 00 00`  ← **8 バイトのゼロシード＝非暗号化を示す**
   - `USERVAR "IBMSUBSPW" VALUE <password-ascii>`  ← ゼロシードなので**平文パスワード**

> user のみ指定（password 省略）なら IBMRSEED/IBMSUBSPW は送らない。DEVNAME のみ／空 IS も可。
> この方式で PUB400（IBM i 7.5）はバインド時に認証し、signon 画面を経ずメニューへ到達する（decisions 01/D3）。

---

## 3. GDS レコードヘッダ（RFC 1205）

telnet の下、各 5250 レコードは以下のヘッダを持つ:

```
LL(2)  type(2)=12A0  reserved(2)=0000  varHdrLen(1)  flag1(1)  flag2(1)  opcode(1)  data...
```

- `LL` = レコード全体のバイト長（LL 自身を含む）。
- `varHdrLen` = 可変ヘッダ長（自身を含む）。基本 **04**（flag1+flag2+opcode の 3 バイト＋自身）。`04` 超は拡張ヘッダとして読み飛ばす。
- `flag1` ビット: `ERR=80 ATN=40 SRQ=04 TRQ=02 HLP=01`（RFC 1205 / tn5250 record.h 一致）。`flag2` は未使用（00）。
- `opcode`（ホスト→クライアントの指標。全 opcode でデータは処理する）:

| opcode | 名称 | | opcode | 名称 |
|---|---|---|---|---|
| 00 | NO-OP | | 06 | READ IMMEDIATE |
| 01 | INVITE | | 08 | READ SCREEN |
| 02 | OUTPUT ONLY | | 0A | CANCEL INVITE |
| 03 | PUT/GET | | 0B | MESSAGE LIGHT ON |
| 04 | SAVE SCREEN | | 0C | MESSAGE LIGHT OFF |
| 05 | RESTORE SCREEN | | | |

クライアント→ホストのレコードは opcode に応じて `PUT_GET(03)`（AID 応答）や `NO-OP(00)`（フラグレコード・Query Reply）を用いる。

---

## 4. 受信データストリーム（ホスト → クライアント）

ヘッダ後の本体は `ESC(04)` ＋コマンド、の並び。コマンドの後にオーダー列が続く。

### 4.1 コマンド（ESC 04 に続く 1 バイト）

| 値 | コマンド | | 値 | コマンド |
|---|---|---|---|---|
| 11 | WRITE TO DISPLAY (WTD) | | 52 | READ MDT FIELDS |
| 40 | CLEAR UNIT | | 82 | READ MDT FIELDS (ALT) |
| 20 | CLEAR UNIT ALTERNATE | | 62 | READ SCREEN |
| 50 | CLEAR FORMAT TABLE | | 21 | WRITE ERROR CODE |
| 42 | READ INPUT FIELDS | | 02 / 12 | SAVE / RESTORE SCREEN |
| 23 | ROLL | | F3 | WRITE STRUCTURED FIELD (WSF) |

- WTD / WEC の直後に **CC1・CC2**（2 バイトの制御文字）が付く。
  - CC1 上位 3 ビット: キーボードロック・MDT リセット・非 bypass の null 化（`40`=MDT リセット, `60`=全 MDT リセット,
    `80`=非 bypass を null, `A0/C0/E0`=組合せ）。非 `00` はロック。
  - CC2: `08`=キーボードアンロック, `04`=アラーム。
- Read 系（42/52/82）は入力待ちを示す。応答形式は §6。

### 4.2 WTD オーダー

| 値 | オーダー | 引数 |
|---|---|---|
| 11 | SBA（Set Buffer Address） | row(1) col(1)（**1 始まり**、直値） |
| 1D | SF（Start of Field） | [FFW(2)] [FCW(2)*] attr(1) length(2)（§4.4） |
| 01 | SOH（Start of Header） | len(1) ＋ len バイト（読み飛ばし＋フォーマットテーブルクリア） |
| 13 | IC（Insert Cursor） | row(1) col(1) |
| 14 | MC（Move Cursor） | row(1) col(1) |
| 02 | RA（Repeat to Address） | row(1) col(1) fill(1) → 現在位置〜target を fill で埋める |
| 03 | EA（Erase to Address） | row(1) col(1) len(1) ＋(len-1)属性型 → 消去（target 含む） |
| 10 | TD（Transparent Data） | len(2) ＋ len バイト（そのまま配置） |
| 15 | WDSF（§5） | LL(2) class(1)=D9 type(1) body |

- SBA/IC/MC の row/col は **1 始まりの直値**（3270 のような 12/14 ビット符号化ではない）。
- 未知コマンド/オーダーは警告し当該レコードの残りを打ち切る（回復不能時のみ切断）。

### 4.3 属性バイト（0x20–0x3F）

画面上 **1 桁**を占有し（表示は空白）、以降のセルの表示属性を決める。デコード表（SC30-3533。カラーは
green/white/red/turquoise/yellow/pink/blue）:

| 値 | 属性 | 値 | 属性 | 値 | 属性 | 値 | 属性 |
|---|---|---|---|---|---|---|---|
| 20 | 緑 | 28 | 赤 | 30 | 水 桁区切 | 38 | 桃 |
| 21 | 緑 反転 | 29 | 赤 反転 | 31 | 水 桁区切 反転 | 39 | 桃 反転 |
| 22 | 白 | 2A | 赤 点滅 | 32 | 黄 桁区切 | 3A | 青 |
| 23 | 白 反転 | 2B | 赤 反転 点滅 | 33 | 黄 桁区切 反転 | 3B | 青 反転 |
| 24 | 緑 下線 | 2C | 赤 下線 | 34 | 水 下線 | 3C | 桃 下線 |
| 25 | 緑 下線 反転 | 2D | 赤 下線 反転 | 35 | 水 下線 反転 | 3D | 桃 下線 反転 |
| 26 | 白 下線 | 2E | 赤 下線 点滅 | 36 | 黄 下線 | 3E | 青 下線 |
| 27 | 緑 非表示 | 2F | 赤 非表示 | 37 | 黄 非表示 | 3F | 青 非表示 |

- 既定属性（クリア直後・属性桁前）= `20`（通常緑）。
- **フィールド属性はフィールド長で境界付ける**（閉じ属性を送らないアプリで下線等が非編集エリアへ漏れるのを
  防ぐ。ACS 準拠。decisions 参照）。

### 4.4 SF（フィールド定義）・FFW・FCW

`SF` の直後: FFW が無ければ（先頭が属性バイト）出力専用フィールド（`attr(1) length(2)` のみ、フォーマット
テーブル非登録）。FFW があれば `FFW(2)`＋任意個の `FCW(2)`＋`attr(1)`＋`length(2)`。フィールドデータは
属性桁の次から `length` 桁。

**FFW（Field Format Word）ビット**（上位 2 ビット `01` が FFW 識別）:

| ビット | 意味 | ビット | 意味 |
|---|---|---|---|
| C000 / 4000 | ID マスク / ID 値 | 0080 | AUTO ENTER |
| 2000 | BYPASS（protected） | 0040 | FIELD EXIT REQUIRED |
| 1000 | DUP ENABLE | 0020 | MONOCASE |
| 0800 | MDT | 0008 | MANDATORY ENTER |
| 0700 | SHIFT マスク | 0007 | ADJUST マスク |

SHIFT 値（0700 マスク）: `0000`=英数, `0100`=英字専用, `0200`=数字シフト, `0300`=数字専用,
`0400`=カタカナ, `0500`=数字桁専用, `0600`=I/O, `0700`=符号付数字。

**FCW（Field Control Word）**（上位 2 ビット `10`）: DBCS 種別を解釈。`8200`=pure（表意文字専用）、
`8240`=either、`8280`/`82C0`=open。他は読み飛ばし（保持のみ）。

---

## 5. WSF QUERY と Query Reply

### 5.1 QUERY 検出

WSF コマンド（`ESC F3`）の構造化フィールドで **class=D9, type=70**（5250 QUERY）を受けたら Query Reply を返す。
GUI 構造体（§5.3）は WSF ではなく WTD オーダー **15(WDSF)** で届く（decisions 06/D1）。

### 5.2 Query Reply バイト列

`buildRecord(NO-OP, t)` で包む。`t` は非拡張 **61 バイト**（本体長 3A）／enhanced **67 バイト**（本体長 40）。

| idx | 値 | 意味 |
|---|---|---|
| 0,1 | 00 00 | カーソル row/col |
| 2 | 88 | Inbound WSF AID |
| 3,4 | 00 3A（enh: 00 40） | Query Reply 長 |
| 5,6 | D9 70 | class / type(QUERY) |
| 7 | 80 | flag |
| 8,9 | 06 00 | コントローラ HW クラス |
| 10-12 | 01 01 00 | コード レベル |
| 13-28 | 00… | 予約 |
| 29 | 01 | ディスプレイ エミュレーション |
| 30-33 | device type 4 桁（EBCDIC） | 端末タイプ由来（例 "3179"→F3 F1 F7 F9） |
| 34 | 00 | |
| 35,36 | model 2 桁（EBCDIC） | 例 "02"→F0 F2 |
| 37 | 02 | キーボード ID（標準） |
| 38,39 | 00 00 | |
| 40-43 | 00 61 50 00 | シリアル |
| 44,45 | FF FF | 最大入力フィールド数 |
| 46-48 | 00 00 00 | |
| 49,50 | 23 31 | controller/display capability |
| 51,52 | 00 00 | 予約 |
| 53 | **00**（enh: **02**） | 拡張 5250 FCW & WDSF（bit6） |
| 54 | **00**（enh: **80**） | 拡張 UI サポートレベル 2（bit0） |
| 55-（60/66） | 00… | 予約 |

- **enhanced=true** で GUI 構造体をホストが送るようになる（オプトイン。既存の非 GUI 画面に回帰なしを実機確認。decisions 06/D2）。

### 5.3 WDSF GUI 構造体（WTD オーダー 15）

`15 LL(2) D9 type body`。LL は自身の 2 バイトを含む。type 別 body（tn5250 準拠。位置はデータストリームの現在アドレス＝1 始まり row/col）:

- **CREATE_WINDOW (51)**: `fb1(1)` `予約(2)` `depth(1)` `width(1)` ＋任意の境界マイナー構造
  `[borderLen(1) borderType(1) ...]`。fb1: `80`=カーソル制限, `40`=プルダウン。borderType `10`（タイトル/フッタ）の
  `flags,mono,color,予約` の後がタイトル文字（EBCDIC）。
- **DEFINE_SELECTION_FIELD (50)**: ヘッダ 16 バイト = `fb1 fb2 fb3 fieldType 予約×5 itemSize height items padding
  separator selectionChar cancelAid`。fieldType: `01`=メニュー, `11`=単一選択（ラジオ）, `12`=複数選択（チェック）,
  `41/51`=プッシュボタン, `21/22/31/32`=リスト/プルダウン。以降、選択項目マイナー構造の並び
  `[minorTotal(1) minorType(1) content...]`（minorType `10`=選択項目、`01/02/03/09`=表示属性等は読み飛ばし）。
  - **選択項目**（content）: `fb1 fb2 fb3` ＋任意 `[mnemonicOffset] [aid] [numericChar]` ＋ `text(itemSize, EBCDIC)`。
    fb1: `40`=既定選択/`80`=選択不可（bit0-1）, `08`=offset 有, `04`=AID 有, `03`=数字選択有。
    fb3 上位 3 ビットが全 0 なら以降無効。
- **DEFINE_SCROLL_BAR_FIELD (53)**: `fb1(1)` `予約(1)` `total(4)` `sliderPos(4)` `size(1)`。fb1 `80`=水平。
  total/sliderPos は **10 進 4 バイト**（`1000*b1+100*b2+10*b3+b4`）。
- **除去**: `58`=REM_GUI_SEL_FIELD, `59`=REM_GUI_WINDOW, `5B`=REM_GUI_SCROLL_BAR_FIELD, `5F`=REM_ALL_GUI_CONSTRUCTS。

---

## 6. 送信データストリーム（クライアント → ホスト）

### 6.1 AID 応答（Read MDT Fields 形式）

`buildRecord(PUT_GET, body)`。body =

```
cursorRow(1)  cursorCol(1)  AID(1)  { SBA(11) row(1) col(1)  <field value bytes>(EBCDIC) }*
```

- MDT の立った全フィールドを画面順に、各々 **SBA（フィールド先頭の 1 始まり row/col）＋値**で送る。
- 値は末尾ブランクを落とす。tn5250 準拠なら末尾 NUL を除去し、埋め込み/先頭 NUL(00) をブランク(40)へ変換
  （READ_MDT_FIELDS。ALT では変換しない）。
- 送信後キーボードロック、ホストの WTD（CC2 の unlock）で解除。

**AID コード**:

| キー | 値 | キー | 値 | キー | 値 |
|---|---|---|---|---|---|
| Enter | F1 | F1–F12 | 31–3C | F13–F24 | B1–BC |
| Clear | BD | Help | F3 | PageUp(Roll↓) | F4 |
| PageDown(Roll↑) | F5 | Print | F6 | Record Backspace | F8 |

### 6.2 SysReq / Attn（フラグレコード）

データ無しの `buildRecord(NO-OP, [], flags)` を送る。flag1 ビットで表現: **SysReq=SRQ(04)**、**Attn=ATN(40)**。

---

## 7. 文字変換（EBCDIC ⇔ Unicode / DBCS）

- **SBCS**: CCSID 37（既定・英語）。バイト⇔Unicode の 1:1 表。
- **DBCS（EBCDIC_STATEFUL）**: `SO=0E` で DBCS モード、`SI=0F` で SBCS モードへ。
  - 受信: SO/SI をそれぞれ 1 桁の制御セル（表示は空白）として配置し、DBCS 2 バイトを 1 文字にデコードして
    **lead/tail の 2 セル**に割り付ける（桁位置を厳密維持）。
  - 送信: Unicode → 対象 CCSID の DBCS バイト列に変換し SO/SI で囲む。**バイト長（SO/SI 込み）超過は事前検証**
    （超過は `FIELD_OVERFLOW`）。
  - CCSID: 37 / 930 / 939（931/5035 エイリアス）/ 1399。
- **変換表の生成**: ICU の `.ucm`（例 ibm-37 / ibm-930 / ibm-939 / ibm-1399）の SBCS/DBCS セクションから
  双方向 Map を生成（`tools/gen-tables`）。未定義は受信 U+FFFD / 送信 SUB(3F)。他言語では同じ `.ucm` から生成する
  ことで表を一致させられる。

---

## 8. 画面モデル・上位契約・エラー

- **画面スナップショット（ScreenSnapshot）**・**フィールド/セル**・MCP 12 ツール・WebSocket メッセージ・
  設定プロファイルの契約は `spec.md`（「インターフェース / データ構造」）を参照。GUI 構造体（`gui`）の
  スナップショット表現は spec と `screen/types.ts` を参照。
- エラー処理: 未対応コマンド/オーダーは警告＋hex ダンプで読み飛ばし、回復不能時のみ切断（spec「エラー処理」）。

---

## 9. コンフォーマンス（移植版の検証）

- `packages/core/test/fixtures/*.jsonl` は **言語非依存の trace**（`{dir:"rx"|"tx", hex}` の並び。tx は伏字化）。
  移植版で `rx` を順に流し、生成した画面スナップショット／送信バイトが一致することを確認する（本実装の
  リプレイテストと同じ資産）。
- 実機検証は `scripts/`（`.env` に `PUB400_USER`/`PUB400_PASSWORD`）。診断は `scripts/diag-*.mjs`。

> 本書はコードから抽出した要約であり、曖昧な場合は `packages/core/src/protocol/`（`constants.ts` /
> `gds.ts` / `query-reply.ts` / `wdsf-parser.ts` / `read-response.ts` / `wtd-applier.ts`）と
> `codec/` / `screen/attributes.ts`、および `decisions.md` を一次情報とする。
