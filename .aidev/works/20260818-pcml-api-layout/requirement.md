# 要件: 実機 API の PCML を通す（無名域・受取域の大きさ・版の別）

## 背景 / 課題

`20260817-pcml-program-call` で PCML の解析と呼び出しは通った。ただし**通るのは
コンパイラが吐いた記述だけ**で、**IBM が配っている実機 API の記述は 1 つも通らない**。

`jtopen` は `.pcml` を **16 本**同梱している（`pcml/*.pcml`）。実測した使用状況:

| 属性 | 使っている本数 | いまの扱い |
|---|---|---|
| `outputsize` | **14 / 16** | 断る |
| 名前なしの `<data>` | **多数**（予約域） | 断る（`name がありません`） |
| `offset` / `offsetfrom` | 5 / 16 | 断る |
| `minvrm` / `maxvrm` | 3 / 16 | 断る |

**`outputsize` と名前なしはほぼ全部に出てくる**ので、この 2 つが無いと実機 API は 1 本も呼べない。

### 名前なしは「予約域」

IBM の書式は予約バイトを必ず持つ。

```xml
<data name="groupAuthorityType" type="char" length="10"/>
<data                           type="byte" length="3"/>   ← 予約。名前が無い
<data name="userIDNumber"       type="int"  length="4"/>
```

原典では `getName()` が空文字を返し、**完全名が付かない＝名前で触れない**。
ただし**バイトは占める**。落とすと以降が全部ずれる。

### `outputsize` は「受取域の大きさ」

IBM の取得系 API は「受取域」と「受取域の長さ」を組で渡す。
記述は `outputsize="receiverVariableLength"` のように**入力項目を指す**
（実測: 名前指定 34 件はすべて入力の長さ項目、整数指定 7 件）。

原典は**入力バイトと出力バイトを別々に扱う**（`PcmlProgram.callProgram`）:

```java
case INPUT:       new ProgramParameter(passby, bytes);
case OUTPUT:      new ProgramParameter(passby, outputSize);
case INPUTOUTPUT: new ProgramParameter(passby, bytes, outputSize);
```

こちらの `ProgramParameter` も `inout` は `data` と `length` を別に持つので、器はある。
足りないのは**上の層で別々に決める道**。

### `minvrm` / `maxvrm` は引数の**本数**を変える

原典は版に合わない要素を**引数の列から丸ごと落とす**（`isSupportedAtHostVRM`）。
並びがずれるのではなく**本数が変わる**ので、無視すると `MCH0802` になる。

**ホストの版はもう持っている**——`signon.ts` が `rawVersion`（`(V<<16)+(R<<8)+M`）を返す。
`validateVRM` の作る値と**同じ符号化**なので、比べられる。

## 目的 / ゴール

**IBM が配っている `.pcml` で実機 API を呼べる。**
少なくとも `qsyrusri.pcml` / `quslfld.pcml` / `qszrtvpr.pcml` / `qcdrcmdd.pcml` が通る。

## スコープ

### 対象

- **名前なしの `<data>`**（予約域）——バイトは占め、名前では触れない
- **`outputsize`**（整数、または入力項目の名前）——出力の長さを入力と別に決める
- **`minvrm` / `maxvrm`**——ホストの版に合わない引数を落とす
- 上を使う **IBM 同梱の記述**を固定資料として取り込む
- REST と画面が新しい形を扱えること

### 対象外（次の作業へ）

- **`offset` / `offsetfrom`**——理由は下の「なぜ分けるか」
- **出力の値で決まる `count`**（同じ理由）

## なぜ `offset` を分けるか

いまの `pcml-layout.ts` は**呼ぶ前に静的な割り付けを作る**。`offset` はそれと相容れない。

```xml
<data name="offsetToHomeDirectory" type="int"  length="4"/>   ← ホストが書く値
<data                              type="byte" length="0"
      offset="offsetToHomeDirectory" offsetfrom="0"/>          ← そこまで飛べ
<data name="homeDirectory"         type="char" length="..."/>
```

飛び先は**返ってきたバイトを読むまで分からない**。つまり出力の読み取りを
「静的な割り付けの適用」から「**先頭から順に解く**」へ作り替える必要がある。
`count` が出力項目を指す場合も同じ作り替えが要る。

**同じ 1 つの作り替え**なので、まとめて次の作業にする。
本作業は**それが無くても通る記述**（16 本中 9 本）を先に通す。

## 機能要件

- 名前なしの `<data>` は**バイトを占め、値の出し入れの対象にしない**
- `outputsize` は整数と**入力項目の名前**の両方を解く。指定が無ければ算出値
- `outputsize` が算出値より小さい場合は**断る**（ホストが書ける場所が足りない）
- `minvrm` / `maxvrm` に合わない引数は**引数の列から外す**
- ホストの版が分からない場合は**版の指定がある記述を断る**（勝手に通さない）
- `offset` / `offsetfrom` と、出力を指す `count` は**引き続き断る**（理由を言って）

## 非機能要件 / 制約

- 既存 4,382 件を壊さない
- **実機で確かめる**——`qsyrusri.pcml` を IBM の記述のまま使い、
  返った値をユーザープロファイルの実体と突き合わせる

## 完了条件 (受け入れ基準)

- [ ] IBM 同梱の `qsyrusri.pcml` が**手を入れずに**解析できる
- [ ] 同じ記述で**実機の QSYRUSRI を呼べ**、返った値が実体と一致する
- [ ] 名前なしの予約域がバイトを占めることを固定した
- [ ] `outputsize` が入力項目の名前で解けることを固定した
- [ ] 版に合わない引数が列から外れることを固定した
- [ ] `offset` を含む記述は**理由を言って断る**
- [ ] REST と画面から同じことができる
