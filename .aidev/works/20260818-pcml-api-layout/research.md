# 調査: 実機 API の PCML は何を使っているか

## A. IBM は `.pcml` を同梱している（16 本）

`jtopen` の `pcml/` に、IBM 自身が書いた記述がある。**これが実機 API の正解**。

| 記述 | `offset` | `offsetfrom` | `outputsize` | `minvrm` | 名前指定の `count` |
|---|---|---|---|---|---|
| `NetServer.pcml` | 2 | 0 | 5 | 4 | 4 |
| `RJavaProgram.pcml` | 1 | 0 | 3 | 0 | 0 |
| `RJob.pcml` | 0 | 0 | 12 | 0 | 5 |
| `RJobList.pcml` | 0 | 0 | 3 | 0 | 10 |
| `RJobLog.pcml` | 7 | 7 | 2 | 0 | 2 |
| `RMessageQueue.pcml` | 7 | 7 | 3 | 0 | 2 |
| `RPrinter.pcml` | 0 | 0 | 1 | 0 | 0 |
| `RPrinterList.pcml` | 0 | 0 | 2 | 2 | 4 |
| `RSoftwareResource.pcml` | 0 | 0 | 1 | 0 | 0 |
| `RUser.pcml` | 3 | 3 | 5 | 0 | 5 |
| `RUserList.pcml` | 0 | 0 | 2 | 1 | 2 |
| `qcdrcmdd.pcml` | 0 | 0 | 1 | 0 | 0 |
| `qsyrusri.pcml` | 0 | 0 | 0 | 0 | 0 |
| `qszrtvpr.pcml` | 0 | 0 | 0 | 0 | 0 |
| `quhrhlpt.pcml` | 1 | 0 | 2 | 0 | 2 |
| `quslfld.pcml` | 0 | 0 | 0 | 0 | 0 |

**`outputsize` が 14/16。** これが無いと実機 API はほぼ呼べない。

### `outputsize` の値（実測）

```
15  lengthOfReceiverVariable      13  receiverVariableLength     2  receiverLength
 1  lengthOfReceiverVariableDefinitionInfo   1  lengthOfMessageInformation
 1  length   1  documentSize
 7  整数（64 / 4096 / 32 / 275 / 22 / 165 / 11 / 0）
```

**名前指定はすべて「受取域の長さ」＝入力項目**。呼ぶ時点で決まっているので、
静的な割り付けのままで解ける。

## B. 名前なしの `<data>` は予約域（原典で確認）

DTD で `name` は `#IMPLIED`。`PcmlDocNode.getName()`（156 行）は
`m_Name == null` のとき**空文字**を返し、`getQualifiedName()` は
**名前が空なら完全名を付けない**（途中の段で打ち切る）。

つまり **バイトは占めるが、名前で触れない**。

```xml
<data name="groupAuthorityType" type="char" length="10"/>
<data                           type="byte" length="3"/>   ← 予約
<data name="userIDNumber"       type="int"  length="4"/>
```

## C. `outputsize` は入力と出力を切り離す（原典で確認）

`PcmlProgram.callProgram`（570 / 587 / 608-620 行）:

```java
outputSize = dataNode.getOutputsize(noDimensions);
case INPUT:       new ProgramParameter(passby, bytes);
case OUTPUT:      new ProgramParameter(passby, outputSize);
case INPUTOUTPUT: new ProgramParameter(passby, bytes, outputSize);
```

`getOutputsize()`（`PcmlData.java` 885-）は:

1. `outputsize=` があればその値を返し、**子孫は数えない**
2. 無ければ、構造体なら子の合計、走査型なら自分のバイト長

**入力バイトは算出値のまま**（`toBytes` が書く量は変わらない）。
こちらの `ProgramParameter` は `inout` が `data` と `length` を別に持つので器はある
（`command-datastream.ts` 230-234）。

## D. `minvrm` / `maxvrm` は引数の本数を変える（原典で確認）

`isSupportedAtHostVRM()`（`PcmlData.java` 987-）:

```java
if (getMinvrm() > hostVrm) return false;
if (getMaxvrm() < hostVrm) return false;
```

`callProgram` は false の子を **`childParms[i] = null`** にし、
後段で **null を詰めた新しい配列**を作る（633-643 行）。
つまり**引数の本数そのものが減る**。並びがずれるのではない。

`validateVRM`（`PcmlData.java` 2511-）は `VvRrMm` を読み、
`AS400.generateVRM` = **`(version << 16) + (release << 8) + modification`** にする。

**こちらは同じ値をもう持っている**——`signon.ts` の `rawVersion`（199-204 行）は
`(raw >>> 16)` / `(raw >>> 8) & 0xff` / `raw & 0xff` で `V7R5M0` を組み立てており、
**符号化が一致する**。比較にそのまま使える。

## E. `offset` / `offsetfrom` は静的な割り付けと相容れない（原典で確認）

`PcmlDataValues.parseBytes`（走査型）と `PcmlData.parseBytes` / `PcmlStruct.parseBytes`
（構造体）の 3 か所に同じ算法がある:

1. `offset` を値にする（整数、または**他の項目の値**）
2. 基点を決める
   - `offsetfrom="<名前>"` … その先祖の**開始位置**（解きながら積む表から引く）
   - `offsetfrom="<整数>"` … その値（`0` なら引数の先頭）
   - 無指定 … **親の親の開始位置**
3. `基点 + offset` が現在位置より先なら、**そこまで飛ぶ**

`RUser.pcml` の使い方が典型:

```xml
<data name="offsetToHomeDirectory" type="int"  length="4"/>   ← ホストが書く
<data                              type="byte" length="0"
      offset="offsetToHomeDirectory" offsetfrom="0"/>          ← 長さ 0 の「しおり」
<data name="homeDirectory"         type="char" length="..."/>
```

**飛び先は返ってきたバイトを読むまで分からない。**
いまの `pcml-layout.ts` は呼ぶ前に割り付けを固定するので、この形は載らない。
出力の読み取りを「**先頭から順に解く**」に作り替える必要がある——
出力を指す `count` も同じ作り替えで解ける。**まとめて次の作業**にする。

## F. 決めたこと

1. **名前なしは通す**。バイトは占め、`slots` には入れない（名前で触れない）
2. **`outputsize` は入力と別に持つ**。`ProgramArg` の `bytes` に `outLength?` を足す
3. **算出値より小さい `outputsize` は断る**——ホストが書ける場所が足りず、
   返ってきたバイトが途中で切れる。切れたことに気づけない形の失敗になる
4. **版の比較は `signon` の `rawVersion` を使う**。取れていないのに `minvrm` がある記述は断る
5. **`offset` と出力を指す `count` は引き続き断る**。次の作業で作り替える
