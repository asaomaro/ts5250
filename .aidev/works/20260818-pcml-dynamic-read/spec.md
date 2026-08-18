# 仕様: 出力の逐次解析

## 設計方針

### D1: 読み取りは別の層（`pcml-read.ts`）

組み立て（入力）は**呼ぶ前にすべて決まる**ので静的なままでよい。
読み取りだけが**バイトを読みながら決まる**。混ぜると両方が読みにくくなる。

```ts
export function readPcmlOutputs(call: PcmlCall, outputs, opts): Record<string, string>
```

**外から見た形は変えない**——中身を静的な当てはめから逐次解析に替える。

### D2: 値の表は読みながら育てる

件数・長さ・CCSID・飛び先は「**そこまでに読めた値**」で決まる。
だから戻り値の表そのものを解決に使う。入力値（`values`）にも当たる——
`count` が入力を指す形（前の工程で通した）を壊さないため。

引きの順: **読めた出力 → 入力値 → 記述の `init`**。

### D3: 開始位置はスタック（原典と同じ）

```ts
const stack = new Map<string, number>();   // 完全名 → 開始位置
```

- 名前の無い節は**積まない**
- 子を解き終えたら**外す**——見えるのは先祖だけ

### D4: 外を指したら断る

飛び先・長さが受け取ったバイト列の外なら例外。**黙って空を返さない**——
空の文字列は「値が無い」と読めてしまい、原因にたどり着けない。

### D5: 前には戻らない

飛び先が現在位置より前なら何もしない（原典と同じ）。
IBM の書式は「前詰め＋末尾に可変長」なので、戻る必要が無い。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `hostserver/src/command/pcml-parse.ts` | `offset` / `offsetfrom` を受け入れる。`ccsid` を名前でも |
| `hostserver/src/command/pcml-read.ts` | **新規**——逐次解析 |
| `hostserver/src/command/pcml-layout.ts` | `readPcmlOutputs` を委譲。入力の `offset` を断る |
| `hostserver/src/index.ts` | 公開 |
| `web-ui/src/components/PcmlPane.vue` | 出力で決まる件数の行を「読むまで分からない」と出す |

## 型

```ts
export interface PcmlField {
  // …既存…
  /** 整数、または完全名（相対名は解決済み） */
  offset?: number | string;
  /** 整数、または完全名。省略時は親の開始位置 */
  offsetfrom?: number | string;
  /** 整数、または完全名（`ccsid="ccsidOfTheReturned…"`） */
  ccsid?: number | string;
}

export interface PcmlCall {
  // …既存…
  /** 記述そのもの。読むときに件数・長さ・CCSID を解くのに要る */
  spec: PcmlProgram;
  /** 呼ぶときに使った入力値 */
  values: Readonly<Record<string, string>>;
}
```

## 完了条件との対応

| 受け入れ基準 | どこで |
|---|---|
| 16 本すべて解析できる | `pcml-ibm.test.ts` |
| `USRI0300` を実機で呼べる | `scripts/verify-pcml-dynamic.mjs` |
| 出力で決まる件数・長さ・CCSID | 同上＋単体 |
| 外を指したら断る | 単体 |
| REST と画面 | 既存の経路（読み取りが差し替わるだけ） |
