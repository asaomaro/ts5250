# 調査: 逐次解析の算法（原典）

## A. 飛び先の決め方（3 か所に同じ算法がある）

- `PcmlDataValues.parseBytes`（走査型の項目）
- `PcmlData.parseBytes` 1130-1183（`type="struct"` の項目）
- `PcmlStruct.parseBytes` 870-920（その場に書かれた構造体）

```
myOffset = offset= の値（整数、または他の項目の値）
if (myOffset > 0):
    base =
        offsetfrom が名前   → offsetStack[その名前]        （無ければ例外）
        offsetfrom が整数   → その整数
        offsetfrom が無い   → offsetStack[親の完全名]
    myOffset += base
    if (myOffset < 0 or myOffset > bytes.length): 例外
    if (myOffset > 現在位置): skip = myOffset - 現在位置
```

**前には戻らない**（`myOffset > offset` のときだけ飛ぶ）。

戻り値は **`nbrBytes + skipBytes`**——飛んだ分も「消費した」として親へ返す。

## B. 開始位置の記録は**スタック**（`PcmlStruct.parseBytes` 930-980）

```java
String qName = getQualifiedName();
if (!qName.equals("")) offsetStack.put(qName, offset + skipBytes + nbrBytes);
… 子を順に解く …
if (!qName.equals("")) offsetStack.remove(qName);
```

- **名前の無い節は積まない**（完全名が空）
- 子を解き終えたら**外す**——見えるのは**先祖だけ**

## C. 名前で決まる属性は 5 つ（原典の `m_…Id`）

| 属性 | 出典 | 意味 |
|---|---|---|
| `count` | `PcmlData.setCount` 1460 | 件数 |
| `length` | `PcmlData.setLength` 1527 | バイト長／桁数 |
| `outputsize` | `PcmlData.setOutputsize` | 受取域の大きさ |
| **`ccsid`** | `PcmlData.setCcsid` 1491 | 文字の CCSID |
| `offset` | `PcmlData.setOffset` | 飛び先 |

いずれも「整数として読めなければ要素名」。**`ccsid` は前の工程で見落としていた**。

## D. 実機で試す相手（`RUser.pcml` の `USRI0300`）

```xml
<program name="qsyrusri_usri0300" path="/QSYS.LIB/QSYRUSRI.PGM">
  <data name="receiverVariable"       usage="output" type="struct" struct="usri0300"
                                      outputsize="receiverVariableLength"/>
  <data name="receiverVariableLength" usage="input"  type="int"  length="4" init="1526"/>
  <data name="formatName"             usage="input"  type="char" length="8" init="USRI0300"/>
  <data name="userProfileName"        usage="input"  type="char" length="10"/>
  <data name="errorCode"              usage="input"  type="int"  length="4" init="0"/>
</program>
```

`usri0300` の末尾に、**この工程で扱いたいものが全部入っている**:

```xml
<data type="byte" length="0" offset="offsetToArrayOfSupplementalGroups" offsetfrom="0"/>
<data name="supplementalGroups" type="char" length="10" count="numberOfSupplementalGroups"/>
<data type="byte" length="0" offset="offsetToHomeDirectory" offsetfrom="0"/>
<data name="homeDirectory" type="struct" struct="homeDirectory"/>
<data type="byte" length="0" offset="offsetToLocalePathName" offsetfrom="0"/>
<data name="localePathName" type="char" length="lengthOfLocalePathName"/>
```

さらに `homeDirectory` の中で:

```xml
<data name="homeDirectoryNameValue" type="char"
      length="numberOfBytesInTheHomeDirectoryName"
      ccsid="ccsidOfTheReturnedHomeDirectoryName"/>
```

**出力で決まる長さと CCSID**が同じ 1 項目に来る。ここが通れば算法は正しい。

突き合わせ先は `QSYS2.USER_INFO.HOME_DIRECTORY`。

## E. 入力側に `offset` は無い（16 本を実測）

| 記述 | `offset` の位置 |
|---|---|
| `RUser` / `RJobLog` / `RMessageQueue` / `NetServer` / `RJavaProgram` / `quhrhlpt` | **すべて出力の受取域の中** |

だから**入力側は据え置き**にする。実例の無いものを実装しない
（実装しても確かめようがなく、確かめていないものは動くとは言えない）。

## F. 決めたこと

1. **読み取りを別の層にする**（`pcml-read.ts`）。組み立て（`pcml-layout.ts`）は入力専用に残す
2. `PcmlCall` に**記述そのもの**（`PcmlProgram`）と入力値を持たせる——
   読むときに件数・長さ・CCSID を解くのに要る
3. **`slots` は残す**（入力の詰め方はいまのまま）。読み取りは使わない
4. 入力の引数に `offset` があれば**断る**
5. **前には戻らない**。飛び先が現在位置より前なら何もしない（原典と同じ）
