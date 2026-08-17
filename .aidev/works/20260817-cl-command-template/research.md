# 調査

## F1: JTOpen の「テンプレート」の正体は `QCDRCMDD`

`Command#getXML()` / `getXMLExtended()`（`src/main/java/com/ibm/as400/access/Command.java`）が
`/QSYS.LIB/QCDRCMDD.PGM` を呼ぶ。**引数 6 本**（`refreshXML()` を直読）:

| # | 中身 | 備考 |
|---|---|---|
| 1 | 修飾コマンド名 20 バイト | コマンド 10 ＋ ライブラリー 10（EBCDIC・空白詰め） |
| 2 | 受信変数の長さ（4 バイト整数） | |
| 3 | あて先の書式名 `DEST0100`（8 バイト） | |
| 4 | 受信変数（出力） | 先頭 4＝返った長さ、次の 4＝必要な長さ、**8 バイト目から XML** |
| 5 | 受信の書式名 `CMDD0100` / `CMDD0200`（8 バイト） | 0200 は新しく、未対応機では `CPF3C21` |
| 6 | エラーコード | 4 バイトの 0＝例外で返す |

**2 回呼ぶ**——1 回目は長さ 8 で「必要な長さ」だけ取り、2 回目に本体を取る。
**XML は UTF-8（CCSID 1208）**で返る（JTOpen も `ConvTable.getTable(1208)` を使う）。

> jt400 は**XML を返すところまで**で、コマンド文字列の組み立ては持たない。
> 「テンプレートを使って実行」の**実行側は自分で書く**ことになる。

## F2: 実機で引けることを確かめた（社内 IBM i）

`CRTLIB` → 3,567 文字。1 回目の呼び出しは `bytesReturned=0` / `bytesAvailable=3575` を返し、
2 回目で本体が取れた（JTOpen も `bytesReturned` は見ずに `bytesAvailable` を使う）。

## F3: テンプレートの構造（実測した XML から）

```
<QcdCLCmd DTDVersion="1.0">
  <Cmd CmdName Prompt MaxPos CCSID …>
    <Parm Kwd PosNbr Type Min Max Len Rstd Dft Prompt Choice …>
      <SpcVal><Value Val="*PROD" MapTo="PROD"/>…</SpcVal>
      <Qual Type Min Max Len Rstd Dft …>…</Qual>     ← Type="QUAL" のとき
```

| 属性 | 意味（組み立てに効くもの） |
|---|---|
| `Kwd` | キーワード（`LIB` など） |
| `Type` | `NAME` / `CHAR` / `DEC` / `QUAL` / `ELEM` / `*` 系 |
| `Min` | **1 以上なら必須** |
| `Max` | **2 以上なら繰り返し**（`KWD(A B C)`） |
| `Len` | 桁数 |
| `Rstd` | `YES` なら **`SpcVal` / `Choice` の値しか許されない** |
| `Dft` | 既定値（省略時にホストが使う。こちらでは付けない） |

`CPYF` は `Type="QUAL"` に `<Qual>` が 2 つ（オブジェクト名・ライブラリー）入る（12,229 文字）。

## F4: 既存の実装との関係

`packages/hostserver/src/command/` に **実行と汎用プログラム呼び出しが既にある**:

- `CommandConnection.run(command: string)` — CL の実行
- `CommandConnection.call(program, library, params)` — 任意のプログラム呼び出し
  （`{ type: "in", data }` / `{ type: "out", length }` / `{ type: "inout", data, length }`）

**足りないのは組み立て側だけ**。取得は `call()` に乗る。

## F5: 引用の作法（要検証）

CL の値は「そのまま置ける」ものと「引用が要る」ものがある。**組み立ての肝**はここ。

- `*PROD` のような特殊値・`NAME` 型 → **引用しない**
- 空白・小文字・記号を含む文字値 → **`'…'` で囲む**
- 値の中の `'` → **`''` に二重化**

**実機で確かめる**——`CRTLIB` の `TEXT` に空白・小文字・`'` を含む値を渡して作り、
`QSYS2.OBJECT_STATISTICS` で読み戻して一致を見る。
