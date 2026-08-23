# 調査: DDM レコードレベル書き込み

**原典を直読した**（AGENTS.md「知識ベースや類推で書き始めない」）。
取得: `git clone --depth 1 --filter=blob:none --sparse https://github.com/IBM/JTOpen.git`
→ `archived/jtopenlite/com/ibm/jtopenlite/ddm/`（15 ファイル 4,361 行）。
リポジトリには取り込んでいない（作業ディレクトリのクローンに留めた）。

## F1. DDM は既存のホストサーバーと握手が違う ★最重要

| | 既存（signon/db/command/netprint/ifs） | **DDM** |
|---|---|---|
| ポート | 8471 系（ポートマッパー 449 で解決） | **446**（DRDA 標準） |
| 開始手順 | `0x7001` 乱数交換 → `0x7002` サーバー開始 | **EXCSAT → ACCSEC → SECCHK** |
| 共通化 | `server-connect.ts` の `startHostServer()` | **使えない** |

`DDMConnection.getConnection`（`:115-240`）の実測手順:

1. **EXCSAT**（CP `0x1041`）を送る → **EXCSATRD**（CP `0x1443`）を受け、
   `EXTNAM`（CP `0x115E`）からジョブ文字列を取る
2. **ACCSEC**（CP `0x106D`）を送る。`SECMEC`（CP `0x11A2`）に
   **8=SHA / 6=DES**、`SECTKN`（CP `0x11DC`）にクライアント乱数 8 バイト
   → **ACCSECRD**（CP `0x14AC`）を受け、10 バイト読み飛ばして**サーバー乱数 8 バイト**
3. **SECCHK**（CP `0x106E`）を送る。`USRID`（CP `0x11A0`）に **EBCDIC 10 バイト**、
   `PASSWORD`（CP `0x11A1`）に置換値
   → **SECCHKRD**（CP `0x1219`）→ `SECCHKCD`（CP `0x11A4`）の **rc が 0 なら成功**

### 既存資産がそのまま使える部分（原典が明言）

`getUserBytes` / `getPasswordBytes` / `getEncryptedPassword` には
**`// Copied from HostServerConnection.`** というコメントが付いている（`:242`, `:264`）。
つまり**資格情報のバイト化とパスワード置換値の生成は、既に実装済みのものと同一**
（`20260718-acs-data-transfer` の research F0 の見立てどおり）。

ただし `info.getPasswordLevel()` を使うので、**DDM でも先に signon が要る**
（既存の 4 接続と同じく、passwordLevel を得るため）。

### フレームの形も違う

既存は 20 バイトヘッダー＋LL/CP。DDM は **6 バイトヘッダー**
（LL 2 / GDS ID 1（`0xD0`）/ フォーマット ID 1 / 相関 ID 2）＋ LL/CP。
`transport/host-connection.ts` は 20 バイト前提なので、**共有できるのはソケットの層だけ**。

## F2. ファイルを開く（S38OPEN）

`sendS38OpenRequest`（`:1732-1810`）。UFCB（User File Control Block）を組み立てる。

- S38OPEN CP `0xD011`、`DCLNAM` CP `0x1136`（8 バイトの宣言名）、`S38UFCB` CP `0xD11F`
- UFCB 長 = `106 + (コミット制御?3:0) + (keyed||read?3:0)`
- ファイル名 / ライブラリ（`0x0048`=72 WDMHLIB）/ メンバー（`0x0049`=73 WDMHMBR）を
  **EBCDIC 10 バイト空白詰め**で書く
- open オプション: `0x1002` を基底に、**書き込み専用は `|= 0x10`**、読み取り専用 `|= 0x0020`、
  読み書き `|= 0x3C`
- `0x20000000`（レコードブロッキング ON）、`0x02000000`（**NULL 可能フィールドを扱う**）
- `LVLCHK`（CP 6）に 0 ＝ **レベルチェックをしない**
- `SEQONLY`（CP 58）: 読み書き両方なら `0x40`、片方だけなら `0xC0` ＋ ブロッキング係数
- レコード形式グループ（CP 9）に形式名を EBCDIC 10 バイト、末尾に `32767`

返り（`:427-510`）は **S38OPNFB**（CP `0xD404`）。ここから取れる重要な値:

- 実際のファイル / ライブラリ / メンバー名（各 EBCDIC 10 バイト）
- **`recordLength`**（レコード長）
- **`recordIncrement`**（レコード間隔。NULL マップ等を含む実バイト数）
- **`nullFieldByteMapOffset`**
- `ccsid`、`totalFixedFieldLength`

途中に **S38MSGRM**（CP `0xD201`）が来たらエラーメッセージ。

## F3. レコードを書く（S38PUTM + S38BUF）

`write`（`:849-857`）は 2 フレームを続けて送る。

```
S38PUTM: 0x0016D051（長さ 0x16 ＋ GDS 0xD0 ＋ フォーマット 0x51）
         相関 ID 2 バイト
         0x0010D013（S38PUTM の LL と CP）
         0x000C1136（DCLNAM の LL と CP）＋ DCLNAM 8 バイト
S38BUF:  LL = recordIncrement + 10
         0xD003（GDS ＋ フォーマット）／相関 ID
         LL = recordIncrement + 4、CP = 0xD405
         レコードデータ（recordLength バイト）
         残り（recordIncrement - recordLength）を **NULL 指標**で埋める
           → 各バイト 0xF1 = NULL、0xF0 = 非 NULL
```

**要点**: `recordIncrement` と `recordLength` の差が NULL 指標マップである。
指標を渡さない場合は全バイト `0xF0`（非 NULL）で埋める。

閉じるのは `sendS38CloseRequest` → 応答の S38MSGRM（CP `0xD201`）を集める（`:298-337`）。

## F4. レコード形式（列の配置）をどう得るか ★設計の分岐点

原典は `getRecordFormat`（`:572-`）で DDM 経由の専用経路を持ち、
`DDMRecordFormatReader`（135 行）＋ `DDMField`（**1,220 行**）を要する。
`DDMField` が大きいのは**全データ型の読み書き変換**を抱えているため。

**しかしこのプロジェクトには既に SQL がある。** `QSYS2.SYSCOLUMNS` から
列の順序・型・長さ・精度・位取りが取れる（`20260718-hostserver-sql` で実証済み）。

→ **DDM の record format reader を実装せず、SQL で列レイアウトを得る**案が成立する。
   これで `DDMField` 相当 1,220 行の移植を丸ごと回避できる。

**この案のリスク**: 物理レコードのバイト配置が SQL のメタデータから正しく計算できるか。
固定長の CHAR / DECIMAL(パック) / NUMERIC(ゾーン) / INTEGER なら
順番に連続配置されるはずだが、**VARCHAR は 2 バイトの長さ接頭辞**を持ち、
日付時刻や DBCS は別の扱いが要る。

→ **spec で対応する型を絞り、対応外は明示的に失敗させる**。
   そして**実機で書いて SQL で読み返して**レイアウトの正しさを確かめる（別経路の確認）。

## F5. 参考: DCLNAM の採番

`generateDCLNAM`（`:1503-`）は 8 バイトの EBCDIC 数字（`0xF0`＋数字）で、
接続内の連番。ファイルごとに一意であればよい。

## 未確認（実機で確かめる）

- PUB400 で **446 番ポートが開いているか**（DDM サーバーが動いているか）
- TESTLIB に書き込み可能な物理ファイルを作れるか（`CRTPF` の権限）
- SQL メタデータから計算したレコードレイアウトが実際に一致するか（F4 のリスク）
