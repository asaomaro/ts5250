# 調査: ホストサーバー経由の SQL 実行

## 調査の問い

- Q1: database サーバーの接続手順とデータストリーム形式は？
- Q2: SQL 実行の経路（`executeImmediate` か `prepare`→`describe`→`open`→`fetch` か）
- Q3: 結果セットのメタデータはどう受け取るか
- Q4: 各データ型のバイト表現は？
- Q5: DBCS 列の扱いは？（列ごとの CCSID か、SO/SI が入るか）
- Q6: NULL 指標の形式は？
- Q7: 10 進数の精度をどう扱うか
- Q8: PUB400 で USER は MYLIB に表を作成できるか

## 判明した事実

### F1: 接続は signon → database の 2 本立て。認証は実装済みのものを再利用できる

出典: `DatabaseConnection.getConnection()`

```java
SignonConnection conn = SignonConnection.getConnection(isSSL, system, user, password);
// → SystemInfo（パスワードレベルを含む）を得てから database ポートへ接続
String jobName = connect(info, dout, din, 0xE004, user, password);
```

- database の**サーバー ID は `0xE004`**（signon は `0xE009`）
- 既定ポートは **8471 / TLS 9471**
- 認証は `HostServerConnection.connect()` ＝ **`0x7001`（乱数シード交換）→ `0x7002`（サーバー開始）**。
  パスワード置換値と資格情報のバイト化は signon と完全に同一で、**前段の実装がそのまま使える**
- **先に signon 接続が必要**な理由はパスワードレベルの取得。`SystemInfo` を得るためだけに 1 本張る

### F2: 応答ヘッダーは 40 バイト（signon の 20 と違う）。ただし既存パーサが流用できる

出典: `DatabaseConnection.readReplyHeader()`

```
0  : UInt32BE 全体長          4 : UInt16BE HeaderID    6 : UInt16BE ServerID
8  : UInt32BE CS instance    12 : UInt32BE CorrelationID
16 : UInt16BE TemplateLen    18 : UInt16BE ReqRepID   ← 応答は常に 0x2800
--- ここまで 20 バイト（signon と同一）---
20 : UInt32BE ORS bitmap     24 : UInt32BE compressed（先頭バイトのみ有効）
28 : UInt16BE returnORSHandle 30: UInt16BE returnDataFunctionID
32 : UInt16BE requestDataFunctionID
34 : UInt16BE rcClass        36 : UInt32BE rcClassReturnCode
--- ここまで 40 バイト（template 長 = 20）---
40〜: LL/CP パラメータ列
```

**前段で実装した `parseReply` はパラメータ開始位置を `HEADER_LEN + templateLen` で求める**ため
（前段 decisions D4 の修正）、この 40 バイト形式でもそのまま動く。
ただし **template の先頭 4 バイトは戻りコードではなく ORS bitmap** なので、
database 用の template パーサを別に用意する必要がある（`rcClass` / `rcClassReturnCode` が
エラー判定に使われる）。

### F3: SELECT は prepare → describe → open → fetch。RPB を先に作る

出典: `JDBCStatement.executeQuery()`

```
1. createRequestParameterBlock(rpbID)   … 接続ごとに 1 回
2. prepareAndDescribe(...)              … SQL を渡し、列メタデータを受け取る
3. openAndDescribe(...)                 … カーソルを開く（blockingFactor 指定可）
4. fetch(...)                           … 行を取得
```

`executeImmediate` では**列メタデータが得られない**。コメントに
「Just a plain prepare doesn't give us extended column metadata back」とあり、
`prepareAndDescribe` を使う必要がある。

### F4: 列メタデータは型・桁・位取り・**列ごとの CCSID** を返す

出典: `DatabaseDescribeCallback`

```java
resultSetDescription(numFields, dateFormat, timeFormat, dateSeparator, timeSeparator, recordSize)
fieldDescription(fieldIndex, type, length, scale, precision, ccsid, joinRefPosition, attributeBitmap, lobMaxSize)
fieldName(fieldIndex, name)
```

- **CCSID は列ごとに返る**（Q5 の答え）
- **日付/時刻の書式は結果セット単位**（`dateFormat` / `dateSeparator`）で、値そのものではなくセッション設定

### F5: 型コードと、+1 が NULL 可を表す

出典: `DB2Type.java` / `Column.java`（`case DB2Type.CHAR+1:` の形）

| コード | 型 | 備考 |
|---|---|---|
| 384 / 388 / 392 | DATE / TIME / TIMESTAMP | **固定長の文字表現**（F7） |
| 448 / 452 | VARCHAR / CHAR | |
| 464 / 468 | VARGRAPHIC / GRAPHIC | **DBCS**（純 2 バイト。SO/SI は入らない） |
| 480 | FLOATINGPOINT | 長さ 4 なら REAL、8 なら DOUBLE |
| **484** | **DECIMAL** | **パック 10 進数** |
| **488** | **NUMERIC** | **ゾーン 10 進数** |
| 492 / 496 / 500 | BIGINT / INTEGER / SMALLINT | 8 / 4 / 2 バイト |
| 404 / 408 / 412 | BLOB / CLOB / DBCLOB | 対象外 |

**偶数 = NOT NULL、+1 した奇数 = NULL 可**（Q6 の一部）。

### F6: 行は固定長レコード。可変長は 2 バイトの長さ前置

出典: `Column.java`

- 各列は行内に**固定オフセット** `offset_` を持ち、`rowOffset + offset_` で切り出す
- `VARCHAR` / `LONGVARCHAR`: 先頭 2 バイトが**バイト長**、その後にデータ
- `VARGRAPHIC`: 先頭 2 バイトが**文字数**。バイト長は ×2
- `CHAR` / `GRAPHIC`: 長さ前置なし（固定長）
- CCSID `1200` / `13488` は UTF-16 として特別扱いされている

### F7: 日付・時刻・タイムスタンプは「書式化された固定長文字列」

実機の `DSPFFD MYLIB/SQLTYPES` で確認:

```
D_DATE   DATE       長さ10  バッファ10  オフセット55   Date Format: *ISO   CCSID 273
D_TIME   TIME       長さ 8  バッファ 8  オフセット65   Time Format: *ISO   CCSID 273
D_TS     TIMESTAMP  長さ26  小数6      オフセット73                        CCSID 273
```

数値としてではなく**文字列として**行バッファに入る。`*ISO` なら `2026-07-18` / `12.34.56` の形。
書式は F4 の `dateFormat` / `dateSeparator` に従うため、**書式を固定して要求するのが安全**
（受け取り側で書式を推測しない）。

### F8: NULL 指標は行データと**別に**届く

出典: `DatabaseFetchCallback`

```java
newResultData(rowCount, columnCount, rowSize);
newIndicator(row, column, tempIndicatorData);   // ← 列ごとに別途
newRowData(row, tempData);
```

ビットマップではなく、行×列の指標データとして届く（Q6 の答え）。

### F9: パック 10 進数の形式（精度を保つ文字列変換がある）

出典: `Conv.packedDecimalToString()`

```
・1 バイトに 2 桁（上位ニブル・下位ニブル）
・最終ニブルが符号: 0x0B または 0x0D が負、それ以外（0x0C / 0x0F）が正
・桁数が偶数なら先頭に 0 が入る（numDigits を奇数へ切り上げ）
・バイト長 = numDigits/2 + 1
・scale で小数点位置を決める
```

**ゾーン 10 進数**（`Conv.zonedDecimalToString()`）:

```
・1 バイトに 1 桁（下位ニブルが数字）
・最終バイトの【上位】ニブルが符号（パックは最終【ニブル】が符号。位置が違う）
```

いずれも **`double` を経由しない文字列変換が用意されている**。Q7 の答えとして、
精度を落とさない実装は可能。

### F10: PUB400 で USER は MYLIB に表を作成できる（実機で確認）

`RUNSQL SQL('CREATE TABLE MYLIB.SQLTEST1 (C1 CHAR(5))')` が成功し、
`DSPOBJD` で `MYLIB/SQLTEST1 *FILE PF` を確認した（検証後に削除済み）。

### F11: 検証用テーブル `MYLIB.SQLTYPES` を作成済み

型を網羅したテスト表を実機に用意した。**以降の作業で再利用する**。

| 列 | 型 | 備考 |
|---|---|---|
| `ID` | SMALLINT NOT NULL | 1 = 値あり、2 = 他すべて NULL |
| `C_CHAR` | CHAR(10) | `'ABC'` |
| `C_VAR` | VARCHAR(20) | `'hello'` |
| `N_DEC` | DECIMAL(11,2) | **`-12345678.91`**（負値・パック 10 進数） |
| `N_NUM` | NUMERIC(7,3) | `1.234`（ゾーン 10 進数） |
| `N_INT` | INTEGER | `2147483647` |
| `N_BIG` | BIGINT | **`9007199254740993`**（2^53+1。JS の `number` では表現できない） |
| `N_DBL` | DOUBLE | `1.5` |
| `D_DATE` | DATE | `2026-07-18` |
| `D_TIME` | TIME | `12.34.56` |
| `D_TS` | TIMESTAMP | `CURRENT TIMESTAMP` |
| `G_GR` | GRAPHIC(4) **CCSID 16684** | `UX'65E5672C'`（日本） |
| `G_V` | GRAPHIC(4) **CCSID 300** | `UX'30A230A4'`（アイ） |

**行 2（ID=2）は他の全列が NULL** なので、NULL と空文字の区別をそのまま検証できる。

DBCS 列を 2 種類の CCSID で用意したのは、F4 の「列ごとの CCSID」を実際に踏むため。

### F12: 実機で判明した制約（テストデータ投入時）

- **GRAPHIC に混在 CCSID は指定できない**。`CCSID 1399` は
  `Coded Character Set Identifier 1399 not valid` で拒否された。
  1399 は SBCS/DBCS 混在用で、GRAPHIC には**純 DBCS の CCSID**（16684 や 300）が要る
- **5250 のコマンド行（153 桁）で折り返しがトークンを分断する**。
  `CHAR(10)` が行境界で `CHAR` と `(10)` に割れ、`Token ( was not valid` になった。
  長い DDL は `ALTER TABLE ... ADD` に分割して投入した
  ※ これは 5250 経由でのデータ準備上の制約であり、本実装（SQL 経路）には影響しない

## 影響範囲

- 新規モジュールとして追加でき、既存の TN5250 / signon 実装には触れない
- **前段の資産がそのまま効く**:
  - `hostserver/datastream.ts` の `parseReply`（template 長からパラメータ位置を求める作り）
  - `hostserver/credentials.ts` / `password.ts`（認証は完全に共通）
  - `transport/host-connection.ts`（ソケットとフレーム分割）
- 新たに必要になるもの: database 用 template パーサ、RPB 管理、型変換、カーソル管理
- 既存の DBCS コーデック（`codec/tables/ibm930|939|1399.ts`）は**混在 CCSID 用**。
  GRAPHIC 列は純 DBCS CCSID（16684 / 300）なので、**そのままでは使えない可能性が高い**
  （spec で要検討。DBCS 部分の対応表が引けるかを確認する）

## 実現性 / リスク

**実現性は高い。** 認証という最大の関門は前段で解決済みで、プロトコルの構造も判明した。

### リスク 1: 純 DBCS CCSID（16684 / 300）の変換表を持っていない

既存のテーブルは 930 / 939 / 1399 という**混在**用。GRAPHIC 列が返す 16684 / 300 の
対応表が必要になる。`tools/gen-tables` が ICU の .ucm から生成する仕組みなので、
**同じ経路で追加できる見込み**だが未確認。spec 前に確かめる価値がある。

### リスク 2: 10 進数の返し方が API を左右する

`number` は 2^53 を超えると精度を失う（テスト表の `N_BIG = 9007199254740993` が該当）。
`DECIMAL(11,2)` のような金額も `number` では危うい。選択肢:

| 案 | 利点 | 欠点 |
|---|---|---|
| **文字列で返す** | 精度が落ちない。実装が単純 | 利用側が数値化を意識する |
| `BigInt` | 整数は正確 | 小数を扱えない |
| 専用の Decimal 型 | 正確かつ演算可能 | 依存が増える。core の方針に反する |

**推奨は文字列**。`Conv.packedDecimalToString` 相当がそのまま使え、
利用側が必要に応じて変換できる。ただし**「数値なのに文字列が返る」ことは API の驚きになる**ため、
spec で明示的に決める（BIGINT を `bigint` で返すかも併せて決める）。

### リスク 3: 規模が前段より大きい

前段は 1,066 行だったが、今回は型変換だけで相応の量になる。
plan で **subtask 分割を検討する**（プロトコル層 / 型変換層 / 実機検証、など）。

## spec への申し送り

- 応答ヘッダーは 40 バイト。**既存 `parseReply` は流用できるが、template パーサは別に用意する**
  （先頭 4 バイトは戻りコードではなく ORS bitmap）
- SQL 実行は `prepare`→`describe`→`open`→`fetch`。RPB を接続ごとに 1 回作る
- **日付時刻は書式を明示的に固定して要求する**（受け取り側で推測しない）
- 型コードは**偶数 = NOT NULL、奇数 = NULL 可**。判定は最下位ビット
- **10 進数と BIGINT の返し方を spec で決める**（推奨: 10 進数は文字列。BIGINT は要検討）
- **純 DBCS CCSID（16684 / 300）の変換表を用意できるか確認する**。
  `tools/gen-tables` で生成できるかが鍵
- 検証は `MYLIB.SQLTYPES`（F11）を使う。**行 2 が全 NULL** なので NULL 検証に使える
- 前段の非機能要件を踏襲: ピュア層は Node API 非依存、**グローバル（`Buffer` 等）も使わない**
- 規模的に subtask 分割の候補。plan で判断する
