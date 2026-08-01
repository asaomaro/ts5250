# 調査: LOB をまとめて取る要求形式は原典にあるか

調査日 2026-08-01。原典は **JTOpen（`github.com/IBM/JTOpen`, ブランチ `main`）** を直読した。
実機は使っていない（資格情報なし）。読んだファイルはリポジトリに取り込んでいない
（AGENTS.md: 同梱頒布になる）。

> **検証方法**: 本書の引用は**すべて生ソースを直読して確定**した
> （`gh api repos/IBM/JTOpen/contents/<path> --jq .content | base64 -d` で落として `grep`）。
> 最初は取得ツールの要約から書き始めたが、要約は**要約器のモデルが介在する**ため
> 「要求 ID の全列挙」のような**網羅を主張する根拠には使えない**——review で差し戻し、
> 全 26 個の `FUNCTIONID_*` を自分の目で数え直した（protocol「2.6」: 確定は生テキストの直読で行う）。

## 結論（先に）

**まとめ取りの要求形式は無い。** `0x1816`（Retrieve LOB Data）はロケーターを**1 つ**しか取らず、
DB ホストサーバーの要求 ID を全列挙しても複数 LOB 用の要求は存在しない。**原典も 1 個ずつ取っている。**

ただし**原典は往復を減らしている**——別の手段で。**LOB フィールドしきい値**（`0x3822`）を
既定で **32,768 バイト**に設定し、**それ以下の LOB は行データに載せて返させる**。
ロケーターが返るのは、しきい値を**超えた**ときだけ。

**こちらは同じしきい値を意図的に 0 にしている**（`db-connection.ts:42`）。つまり
「往復が多い」のは仕様の欠落ではなく、**こちらが選んだトレードオフの裏側**だった。

## F1. `0x1816` は 1 ロケーター 1 要求（複数は取れない）

`DBSQLRequestDS.java` の LOB 関連セッター（コードポイントは実測どおり）:

| メソッド | CP | 型 |
|---|---|---|
| `setLOBLocatorHandle` | `0x3818` | int（**単数**） |
| `setRequestedSize` | `0x3819` | int |
| `setStartOffset` | `0x381A` | int |
| `setCompressionIndicator` | `0x381B` | byte |
| `setLOBAllocateLocatorIndicator` | `0x381C` | byte |
| `setLOBData` | `0x381D` | byte[] |
| `setReturnCurrentLengthIndicator` | `0x3821` | byte |

`JDLobLocator.retrieveData()` の要求組み立て（逐語）:

```java
request = DBDSPool.getDBSQLRequestDS(
  DBSQLRequestDS.FUNCTIONID_RETRIEVE_LOB_DATA,
  id_, DBBaseRequestDS.ORS_BITMAP_RETURN_DATA
  + DBBaseRequestDS.ORS_BITMAP_RESULT_DATA, 0);
request.setLOBLocatorHandle(handle_);
request.setRequestedSize(length);
request.setStartOffset((int)offset);
```

`handle_` はそのロケーター 1 個のインスタンス変数。**ロケーターの配列を渡す口が無い。**
こちらの `lob.ts:70-80` と同じ形（`uint32(DB_CP.lobLocatorHandle, locator)`）。

`setLOBLocatorHandle` の実体（`DBSQLRequestDS.java:283-287`。逐語）:

```java
	void setLOBLocatorHandle (int value)
		throws DBDataStreamException
	{
  		addParameter (0x3818, value);
	}
```

## F2. 要求 ID を全列挙しても、複数 LOB 用の要求は無い

`DBSQLRequestDS.java:32-57` の `FUNCTIONID_*` **全 26 個**（**網羅の根拠**。
「見つからなかった」ではなく「存在しない」。`grep -cE "FUNCTIONID_[A-Z_]+\s*="` で 26）:

| 定数 | 値 | | 定数 | 値 |
|---|---|---|---|---|
| PREPARE | 0x1800 | | CREATE_PACKAGE | 0x180F |
| DESCRIBE | 0x1801 | | CLEAR_PACKAGE | 0x1810 |
| DESCRIBE_PARM_MARKER | 0x1802 | | DELETE_PACKAGE | 0x1811 |
| PREPARE_DESCRIBE | 0x1803 | | EXECUTE_OPEN_DESCRIBE | 0x1812 |
| OPEN_DESCRIBE | 0x1804 | | END_STREAM_FETCH | 0x1813 |
| EXECUTE | 0x1805 | | RETURN_PACKAGE | 0x1815 |
| EXECUTE_IMMEDIATE | 0x1806 | | **RETRIEVE_LOB_DATA** | **0x1816** |
| COMMIT | 0x1807 | | **WRITE_LOB_DATA** | **0x1817** |
| ROLLBACK | 0x1808 | | CANCEL | 0x1818 |
| CONNECT | 0x1809 | | **FREE_LOB** | **0x1819** |
| CLOSE | 0x180A | | TEST_CONNECTION | 0x0000 |
| FETCH | 0x180B | | | |
| STREAM_FETCH | 0x180C | | | |
| PREPARE_EXECUTE | 0x180D | | | |
| OPEN_DESCRIBE_FETCH | 0x180E | | | |

LOB に関わるのは **3 つだけ**（取得 / 書き込み / 解放）。まとめ取り・ロケーター一覧の要求は無い。

## F3. 原典が往復を減らす手段は「LOB フィールドしきい値」（0x3822）

`DBSQLAttributesDS.java`（接続時の属性要求）:

```java
void setLOBFieldThreshold(int value)
throws DBDataStreamException
{
    addParameter(0x3822, value);
}
```

**意味**は jtopenlite の呼び出し側コメントが最も端的（`jtopenlite/.../jdbc/JDBCConnection.java`）:

```java
dsa.setLOBFieldThreshold(1024*1024); // Use a locator for any LOB data fields longer than 1 MB.
```

→ **しきい値を超えた LOB だけがロケーターになる。以下は行データに載って返る。**
超えなければ**追加の往復は 0**。

### 既定値と上限（数値）

`JDProperties.java:895-902`（逐語）——プロパティ名 `"lob threshold"`、既定 **`"32768"`**:

```java
    // LOB threshold.
    i = LOB_THRESHOLD;
    dpi_[i] = new DriverPropertyInfo(LOB_THRESHOLD_, "");
    dpi_[i].description = "LOB_THRESHOLD_DESC";
    dpi_[i].required = false;
    dpi_[i].choices = new String[0];
    defaults_[i] = "32768";
```

`AS400JDBCConnectionImpl.java:4361-4370`（逐語）:

```java
// Although we publish a max lob threshold of 16777216,
// the system can only handle 15728640.  We do it this
// way to match ODBC.
int lobThreshold = properties_.getInt (JDProperties.LOB_THRESHOLD);
if (lobThreshold <= 0)
    request.setLOBFieldThreshold(0);
else if (lobThreshold >= 15728640)
    request.setLOBFieldThreshold(15728640);
else
    request.setLOBFieldThreshold(lobThreshold);
```

- **単位はバイト**。プロパティの値を **1024 倍せずそのまま**データストリームへ渡す
- **⚠ 資料の記述は誤り**。`JDMRI.java` の `LOB_THRESHOLD_DESC` は
  `"Specifies the maximum LOB (large object) size (**in kilobytes**) that can be retrieved as part of a result set."`
  と書いているが、**コードはバイトとして扱う**（既定 32768＝32KB であって 32MB ではない）。
  MRI の文言を信じて 1024 倍すると 1000 倍ずれる
- **公表上限 16,777,216（16MB）に対し、実際に通るのは 15,728,640（15MB）**。
  「ODBC に合わせるため」とコメントされている。**公表値をそのまま送ってはいけない**
- `<= 0` は「常にロケーター」

## F4. こちらは同じつまみを 0 に倒している（既に測ってある）

`packages/hostserver/src/db/db-connection.ts:41-42, 203-206`:

```ts
/** 0 = LOB は常にロケーター。インライン化させない（応答が巨大になるため） */
const LOB_FIELD_THRESHOLD = 0;
…
// **しきい値は 0 のまま動かさない**。これ以下の LOB はインラインで丸ごと返り、
// 実機で DBCLOB(2M) の表を 2 行取っただけで応答が 8.4MB になった（0 なら 10KB）。
// 大きくすると静かにメモリを食い尽くすので、オプションにもしていない
```

**しきい値の意味はこの実測で既に裏が取れている**（原典のコメントと一致）。
つまり本調査は「原典に別の道があるか」を否定し、**既存の判断が原典と同じ土俵にあること**を確かめた形。

## F5. 副産物: ロケーターの明示的な解放は**存在する**（`0x1819`）

backlog `hostserver.md:360`「ロケーターの明示的な解放（**原典に該当の要求があるかも未確認**）」の答え。

`JDLobLocator.java:367-380`（逐語）:

```java
request = DBDSPool.getDBSQLRequestDS(DBSQLRequestDS.FUNCTIONID_FREE_LOB, id_,
                                     DBBaseRequestDS.ORS_BITMAP_RETURN_DATA, 0);
request.setLOBLocatorHandle(handle_);
// request.setRequestedSize(0);         //@pdd
// request.setStartOffset(0);           //@pdd
// request.setCompressionIndicator(…);  //@pdd
freeReply = connection_.sendAndReceive(request, id_);
```

- 要求 ID **0x1819**、ORS ビットマップは **RETURN_DATA のみ**（結果データを要求しない）
- パラメータは**ロケーターハンドル 1 つだけ**。他は明示的にコメントアウトされている（`@pdd`）
- **戻りのエラーは握り潰している**。コメントに理由:
  `//7,-401 signals already free` /
  `//@free2 host now has various errors if locator is already freed.`

**ただし本 work では実装しない**（requirement の対象外）。この発見は backlog の当該項目に
「原典に要求は在る」という**確定した事実**として反映し、実装・実機確認は残す。

## 実装するなら実機で確かめること（次の work への申し送り）

しきい値を上げる道を採るなら、**単体テストでは絶対に出ない**次の点を実機で見る必要がある。

1. **行データの復号が壊れないか**。`db-decode.ts:110-120` は LOB 列を
   **型コードで判定し 4 バイトのロケーターとして読む**。しきい値を超えない LOB が
   インラインで来ると、行バッファ内の並びが変わる。**列の型コードは同じまま**なのか、
   別の型で来るのかは実測しないと分からない（ここを外すと以降の列が全部ずれる）
2. **応答サイズの跳ね方**。F4 の実測（DBCLOB(2M) × 2 行で 8.4MB）は
   しきい値を上げた瞬間に再現する。`lobMaxBytes` の指定時だけ上げる、
   といった条件付けが要る
3. **どの型に効くか**。CLOB でしか試していない（backlog の別項目）。
   BLOB / DBCLOB で挙動が違わないか

## 参照

- JTOpen `src/main/java/com/ibm/as400/access/DBSQLRequestDS.java`（要求 ID・LOB セッター）
- JTOpen `src/main/java/com/ibm/as400/access/DBSQLAttributesDS.java`（`setLOBFieldThreshold`）
- JTOpen `src/main/java/com/ibm/as400/access/JDLobLocator.java`（`retrieveData` / `free`）
- JTOpen `src/main/java/com/ibm/as400/access/AS400JDBCConnectionImpl.java:4361-4370`（しきい値の上限）
- JTOpen `src/main/java/com/ibm/as400/access/JDProperties.java`（`"lob threshold"` 既定 32768）
- JTOpen `src/main/java/com/ibm/as400/access/JDMRI.java`（`LOB_THRESHOLD_DESC`。**単位の記述が誤り**）
- JTOpen `archived/jtopenlite/com/ibm/jtopenlite/database/jdbc/JDBCConnection.java`（しきい値の意味のコメント）

> ライセンス: JTOpen は **IBM Public License 1.0**。逐語移植はしない。
> 本書の引用は事実確認のための短い抜粋であり、実装は事実（要求 ID・コードポイント・数値）に
> 基づいて書き起こす（AGENTS.md「ライセンスと出典」）。
