# 調査: PCML はどこから来て、何を意味するのか

## A. `PGMINFO(*PCML)` は実機で通る（実測）

`scripts/research-pcml-osaka.mjs`。SR-OSAKA で RPG IV を作り、コンパイル時に吐かせた。

```
CRTBNDRPG PGM(ASAOLIB/PCMLTST) SRCFILE(ASAOLIB/QRPGLESRC) SRCMBR(PCMLTST)
          DFTACTGRP(*NO) PGMINFO(*PCML) INFOSTMF('/home/***/pcmltst.pcml')
                                                              → OK
/home/***/pcmltst.pcml → タグ=819 / 1086 バイト
```

**タグは 819（ISO 8859-1）**。UTF-8 ではない——読む側でそのつもりでいる必要がある。

元の RPG（抜粋）と、吐かれた PCML の全文:

```rpgle
dcl-ds custT qualified template;
  id packed(7:0);  nm char(20);  rate packed(9:4);
end-ds;
dcl-pi *n;
  inTxt char(10) const;   ioNum packed(9:2);   rec likeds(custT);
  items char(5) dim(4);   cnt int(10);   big int(20);   amt zoned(7:2);
end-pi;
```

```xml
<pcml version="6.0">
   <!-- RPG program: PCMLTST  -->
   <struct name="CUSTT">
      <data name="ID" type="packed" length="7" precision="0" usage="inherit" />
      <data name="NM" type="char" length="20" usage="inherit" />
      <data name="RATE" type="packed" length="9" precision="4" usage="inherit" />
   </struct>
   <program name="PCMLTST" path="/QSYS.LIB/ASAOLIB.LIB/PCMLTST.PGM">
      <data name="INTXT" type="char" length="10" usage="input" />
      <data name="IONUM" type="packed" length="9" precision="2" usage="inputoutput" />
      <data name="REC" type="struct" struct="CUSTT" usage="inputoutput" />
      <data name="ITEMS" type="char" length="5" count="4" usage="inputoutput" />
      <data name="CNT" type="int" length="4" precision="31" usage="inputoutput" />
      <data name="BIG" type="int" length="8" precision="63" usage="inputoutput" />
      <data name="AMT" type="zoned" length="7" precision="2" usage="inputoutput" />
   </program>
</pcml>
```

読み取れたこと:

- **`const` は `usage="input"` になる**。それ以外は `inputoutput`
- **構造体は `<struct>` として外に出て、`type="struct" struct="CUSTT"` で参照される**
- **配列は `count`**（ここでは整数）
- `int(10)` → `length="4" precision="31"`、`int(20)` → `length="8" precision="63"`
- **`path` に完全修飾の IFS 形式**が入る（`/QSYS.LIB/…/….PGM`）
- 構造体メンバーの `usage` は **`inherit`**

## B. 意味は原典で確定した（`jtopen` のソース）

推測を使わないため、`PcmlData.java` / `PcmlDocNode.java` / `PcmlDocument.java` を読んだ。

### バイト長（`PcmlDataValues.java` の型別分岐）

| type | バイト長 |
|---|---|
| `char` / `byte` / `int` / `float` | `length` そのもの |
| `packed` | **`length / 2 + 1`**（切り捨て。`length` は桁数） |
| `zoned` | `length`（1 桁 1 バイト） |

### `int` の符号は `precision` で決まる（`PcmlDocument.getConverter`）

| length | 符号つき | 符号なし |
|---|---|---|
| 2 | `precision=15` | `precision=16` |
| 4 | `precision=31` | `precision=32` |
| 8 | `precision=63` | `precision=64` |

実測の `31` / `63` は**符号つき**。RPG の `int` と一致する。

### `usage` の継承（`PcmlDocNode.getUsage`）

**属性が無い、または `inherit` なら親から継ぐ。根まで遡ったら `inputoutput`。**

### 相対名の解決（`PcmlDocNode.resolveRelativeNode`）

`count="OTHER"` のような**他項目への参照**は、こう解く:

> 自分の**親から根に向かって**遡り、各段で `<その段の完全名>.<相対名>` を
> 平坦な要素表から引く。**最初に当たったもの**を採る。

### ホストへ問い合わせる口は無い（`ProgramCallDocument.java`）

構築子は 8 つ（142 / 168 / 198 / 224 / 255 / 287 / 309 / 334 行）。
**いずれも `docName` はクラスパス上の資源か `InputStream`**。
CL の `QCDRCMDD` に当たる「ホストが定義を持っている」経路は**無い**。
だから取得先は **IFS**（＝ A で確かめた道）で正しい。

## C. 宣言どおりのバイト並びで実機が受け取る（実測）

`scripts/research-pcml-layout-osaka.mjs`。A で作った `PCMLTST` を、
**PCML の宣言だけを頼りに生バイトで組んで**呼び、RPG が書いた値が期待位置に出るかを見た。

```
REC は 29 バイト（packed(7,0)=4 + char(20)=20 + packed(9,4)=5）
  PASS IONUM = 12.34 × 2 = 24.68
  PASS REC.ID = 7                      ——構造体は連結**である**
  PASS REC.NM = "REC:HELLO"
  PASS REC.RATE = 1.5000
  PASS ITEMS = AAA,BBB,CCC,DDD          ——配列は反復**である**
  PASS CNT = 4
  PASS BIG = 9000000000                 ——int(8) は 8 バイト
  PASS AMT = 1.00 + 1 = 2.00
8 PASS / 0 FAIL
```

**構造体は「メンバーを順に連結しただけ」、配列は「同じ型を count 回並べただけ」**——
どちらも実機で確かめた。詰め物も境界合わせも無い。

## D. 決めたこと

1. **`.pcml` の取得先は IFS**（コンパイラが吐いたもの）と、**直に渡す文字列**の 2 つ。
   ホスト API は無いので探さない
2. **819 として読む**（実測のタグ）。ただし中身の宣言を優先し、タグは既定値として扱う
3. **`int` は `precision` で符号を決める**。既存の `bin` は符号つき専用なので、
   **符号なしを足す**必要がある
4. **`usage` は継承を実装する**（`inherit` / 属性なし → 親、根なら `inputoutput`）
5. **`count` は整数と相対名の両方**。解決規則は B のとおり原典に合わせる
6. 既存の `ProgramArg`（位置指定）は**残す**。PCML はその上に**名前の層**を重ねる

## E. 積み残し（この作業では扱わない）

- `offset` / `offsetfrom` / `outputsize`——可変長の出力領域。実機 API の PCML で要る
- `date` / `time` / `timestamp`——`dateformat` 等の書式属性が別の沼
- XPCML（`XPCMLHelper.java`）と RFML（`RfmlDocument.java`）
- `.pcml` を**書き出す**向き
