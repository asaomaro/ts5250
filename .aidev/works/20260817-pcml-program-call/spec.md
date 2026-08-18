# 仕様: プログラム界面を「記述」から駆動する（PCML 相当）

## 概要

`ProgramArg`（位置指定・型つき）は既にある。足すのは**その上に載る名前の層**——

1. **`.pcml` を読む**（解析して界面の木にする）
2. **木を平らにする**（構造体と配列を `ProgramArg` の列へ展開する）
3. **名前で値を出し入れする**（`"PGM.REC.NM"`、配列は `"PGM.ITEMS(2)"`）

下の層（`ProgramArg` → バイト列 → `conn.call`）は**一切触らない**。

## 設計方針

### D1: 展開して既存の層に載せる（新しい呼び出し経路を作らない）

構造体と配列は、実機で**連結と反復であることを確かめた**（`research.md` C）。
だから**新しい電文も新しい変換も要らない**——木を平らにすれば既存の `ProgramArg` で足りる。

```
REC (struct CUSTT)  →  bytes(29)   ← ID(4) + NM(20) + RATE(5) を自前で詰める
ITEMS char(5)×4     →  bytes(20)   ← 5 バイトを 4 回
```

**ただし利用者には見せない。** 入れるときも読むときも名前で扱い、
base64 の手詰めは**この層が引き受ける**。

> なぜ「1 引数 = 1 `ProgramArg`」を崩さないか: IBM i の引数は**ポインタの配列**で、
> 構造体は 1 本のポインタとして渡る。分割すると引数の本数が変わり、`MCH0802` になる。

### D2: 読み書きの単位は**文字列**（`number` を経由しない）

既存方針の踏襲（`db-decimal.ts` の注記）。`packed(15,5)` を `number` で往復させると
静かに桁が落ちる。名前で入れる値も、名前で読む値も**文字列**。
`byte` 型だけは base64（表せないものは表せないまま渡す）。

### D3: 解析器は手書き（XML ライブラリを足さない）

`command-template.ts` で `QCDRCMDD` の XML を手書きで解いた前例がある。
PCML も**属性つきの単純な木**で、名前空間も CDATA も要らない。
依存を増やさない方針（`AGENTS.md`）に従い、同じ手口を使う。

**壊れた記述は位置つきで拒否する**——どの行の何が悪いか言えないと直せない。

### D4: 意味は原典に合わせる（`research.md` B で確定済み）

| 事項 | 規則 |
|---|---|
| バイト長 | `packed` = `⌊length/2⌋+1`、`zoned` = `length`、他は `length` |
| `int` の符号 | `precision` が 16/32/64 なら**符号なし**、15/31/63 なら符号つき |
| `usage` | 無い or `inherit` → 親から継ぐ。根なら `inputoutput` |
| `count` | 整数、または**相対名**（親から根へ遡って `<段>.<名>` を引く） |
| 既定 CCSID | 項目に `ccsid` があればそれ、無ければ接続のもの |

### D5: `int` に符号なしを足す

PCML が要求するので、`ProgramArg` の `bin` に `signed?: boolean`（既定 `true`）を足す。
**既定が今の挙動**なので、既存の呼び出しは 1 つも変わらない。

### D6: 可変長配列（`count` が名前）は**入力側の値で決まる**

`count="CNT"` なら、`CNT` に入れた値でバイト長が決まる。
**呼ぶ時点で決まっていなければ拒否する**——黙って 0 件にすると、
ホストは「0 件ぶんの領域」に書き込んで領域外を壊す。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `hostserver/src/command/pcml-parse.ts` | **新規**——`.pcml` → 界面の木 |
| `hostserver/src/command/pcml-layout.ts` | **新規**——木 → `ProgramArg` の列、名前 ↔ 値 |
| `hostserver/src/command/program-args.ts` | `bin` に `signed?` を足す（既定は今と同じ） |
| `hostserver/src/db/db-decimal.ts` | 変更なし |
| `hostserver/src/index.ts` | 公開 |
| `server/src/host-pcml.ts` | **新規**——REST 3 本 |
| `server/src/app.ts` | 登録 |
| `web-ui/src/components/PcmlPane.vue` | **新規**——記述から画面を組む |
| `web-ui/src/paneLabels.ts` / `PanePool.vue` / `LauncherPane.vue` | 導線 |

## 界面の型

```ts
/** `.pcml` 1 つぶん */
export interface PcmlDocument {
  version?: string;
  structs: Map<string, PcmlField[]>;   // <struct name> → メンバー
  programs: Map<string, PcmlProgram>;
}

export interface PcmlProgram {
  name: string;
  path?: string;         // /QSYS.LIB/LIB.LIB/PGM.PGM
  entrypoint?: string;   // サービスプログラムの手続き名
  threadsafe?: boolean;
  fields: PcmlField[];
}

export interface PcmlField {
  name: string;
  type: "char" | "int" | "packed" | "zoned" | "float" | "byte" | "struct";
  usage: "input" | "output" | "inputoutput";   // ← 継承を解決済み
  length?: number;      // char/byte のバイト数、packed/zoned の桁数、int/float のバイト数
  precision?: number;   // 小数位（packed/zoned）、符号の別（int）
  ccsid?: number;
  init?: string;
  passby?: "reference" | "value";
  struct?: string;      // type === "struct" のとき
  count?: number | string;   // 整数、または相対名
  fields?: PcmlField[]; // struct を解決した後のメンバー
}
```

## 名前の書き方

| 書き方 | 指すもの |
|---|---|
| `"PCMLTST.IONUM"` | プログラム直下の項目 |
| `"PCMLTST.REC.NM"` | 構造体のメンバー |
| `"PCMLTST.ITEMS(2)"` | 配列の 2 番目（**1 始まり**。PCML の慣習に合わせる） |
| `"PCMLTST.LIST(3).NAME"` | 構造体配列のメンバー |

**プログラム名から書く**（PCML の `setValue("PGM.parm")` と同じ）。
1 文書に複数のプログラムが入るので、省略はできない。

## REST

| 経路 | すること |
|---|---|
| `POST /api/host/pcml/parse` | `.pcml` の本文か IFS の道を受け、**界面を返す**（画面を組むため） |
| `POST /api/host/pcml/call` | 界面 ＋ 名前つきの入力を受け、**呼んで名前つきで返す** |

`.pcml` の指定は `{ text }` か `{ path }` のどちらか。`path` は IFS から **819 で**読む。

## 完了条件との対応

| 受け入れ基準 | どこで満たすか |
|---|---|
| `PGMINFO(*PCML)` の中身を記録 | `research.md` A（**済**） |
| IFS から読んで解析 | `/parse` の `path` |
| 構造体を渡して受け取る | `pcml-layout.ts`（手詰め無し） |
| 配列（可変長を含む） | `count` の整数と相対名 |
| 名前で入れて名前で読む | `pcml-layout.ts` |
| REST | 上の 2 本 |
| web-ui | `PcmlPane.vue` |
| 実機で往復 | `scripts/verify-pcml-osaka.mjs` |
