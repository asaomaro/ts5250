# 要件: 出力を「先頭から順に解く」——`offset` と、出力で決まる件数・長さ

## 背景 / 課題

`20260818-pcml-api-layout` で IBM 同梱の記述は 16 本中 15 本まで通った。
残る 1 本（`RUser.pcml`）と、実務で効く一覧系（`RJobLog` / `RMessageQueue` /
`NetServer` / `RJavaProgram` / `quhrhlpt`）が通らない。**理由は 1 つ**——

**いまの割り付けは呼ぶ前に固定する。`offset` は返ってきたバイトを読むまで決まらない。**

```xml
<data name="offsetToHomeDirectory" type="int"  length="4"/>   ← ホストが書く値
<data                              type="byte" length="0"
      offset="offsetToHomeDirectory" offsetfrom="0"/>          ← 長さ 0 の「しおり」
<data name="homeDirectory"         type="struct" struct="homeDirectory"/>
```

同じ理由で止まっているものが、ほかに 3 つある:

| 属性 | 例 | いま |
|---|---|---|
| `count` が出力を指す | `count="numberOfSupplementalGroups"` | 断る |
| `length` が出力を指す | `length="lengthOfLocalePathName"` | 断る |
| **`ccsid` が出力を指す** | `ccsid="ccsidOfTheReturnedHomeDirectoryName"` | 未対応（見落としていた） |

**どれも「出力の読み取りを先頭から順に解く」1 つの作り替えで解ける。**

## 目的 / ゴール

**IBM 同梱の 16 本すべてが通る。**
`RUser.pcml` の `USRI0300` で、補助グループ・ホームディレクトリ・ロケール名まで読める。

## スコープ

### 対象

- **出力の読み取りを逐次解析にする**（静的な割り付けの適用をやめる）
- `offset` / `offsetfrom`（整数・相対名・**ドット付きの相対名**）
- 出力で決まる `count` / `length` / `ccsid`
- 入力側は**据え置き**（静的なまま）。入力の引数に `offset` があれば断る

### 対象外

- `date` / `time` / `timestamp` / `varchar`
- XPCML / RFML
- 入力側の `offset`（IBM 同梱 16 本に**実例が無い**——測っていないものを実装しない）

## 実測（IBM 同梱 16 本の `offset` の使われ方）

| 形 | 例 |
|---|---|
| 整数の基点 | `offset="offsetToHomeDirectory" offsetfrom="0"` |
| 基点の省略（親の開始位置） | `offset="lengthOfThisEntry"`（NetServer） |
| **ドット付きの相対名** | `offset="messageWithReplacementData.offsetToTheNextFieldInformation"`（RJobLog） |
| 名前つきの項目に直接 | `<data name="LICOptions" type="char" offset="offsetToLICOptions"/>`（RJavaProgram） |
| 構造体の配列に | `<data name="listData" type="struct" count="nbrEntries" offset="offsetList"/>`（quhrhlpt） |

**すべて出力の受取域の中**にある。入力側の例は 1 つも無い。

## 機能要件

- 出力は**先頭から順に**解く。件数・長さ・CCSID・飛び先は**その時点までに読めた値**で決める
- 飛び先の基点は原典と同じ規則:
  - `offsetfrom="<整数>"` … その値（`0` は引数の先頭）
  - `offsetfrom="<名前>"` … その**先祖**の開始位置
  - 省略 … **親**の開始位置
- 飛び先が現在位置より**前**なら飛ばない（原典と同じ。戻らない）
- 飛び先や長さが受け取ったバイト列の外なら**断る**（黙って空を返さない）
- 解決した CCSID が扱えない場合は、**どの項目のどの CCSID か**を言って断る
- 入力の引数に `offset` があれば断る（実例が無く、測っていない）

## 非機能要件 / 制約

- **既存 4,401 件を壊さない**。`offset` を含まない記述の結果は 1 バイトも変わらない
- **実機で確かめる**——`RUser.pcml` の `USRI0300` を IBM の記述のまま呼び、
  ホームディレクトリを `QSYS2.USER_INFO` と突き合わせる

## 完了条件 (受け入れ基準)

- [ ] IBM 同梱 **16 本すべて**が解析できる
- [ ] `RUser.pcml` の `USRI0300` を実機で呼び、**ホームディレクトリが実体と一致**する
- [ ] 出力で決まる件数の配列（補助グループ）が読める
- [ ] 出力で決まる長さ（ロケール名）が読める
- [ ] 出力で決まる CCSID が使われる
- [ ] 受け取ったバイト列の外を指したら断る
- [ ] REST と画面から同じことができる
