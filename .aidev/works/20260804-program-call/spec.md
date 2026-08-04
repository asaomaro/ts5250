# 仕様: プログラム呼び出しを利用者に開く

## 概要

`CommandConnection.call()` は既にある。足すのは **型付きパラメータの変換** 1 枚と、
MCP / REST / 画面への配線。

## 設計方針

### D1: 型で書けて、生バイトへ逃げられる

```ts
{ type: "char",  dir: "in",    value: "DSPLIBL", length: 20 }
{ type: "packed", dir: "in",   value: "7", digits: 15, decimals: 5 }
{ type: "char",  dir: "out",   length: 50 }
{ type: "bytes", dir: "inout", value: <Uint8Array>, length: 64 }   // 逃げ道
```

**逃げ道を必ず残す。** 外部記述のデータ構造など、型で表せないものは必ず出てくる。
表せないものが渡せなくなると、この機能自体が使えない場面が生まれる。

### D2: 読む向きは既存を使い、書く向きだけ足す

| 変換 | いま | この作業 |
|---|---|---|
| EBCDIC ↔ 文字 | `@ts5250/ebcdic` | そのまま使う |
| 詰め 10 進 → 文字列 | `packedDecimalToString` | そのまま使う |
| ゾーン 10 進 → 文字列 | `zonedDecimalToString` | そのまま使う |
| **文字列 → 詰め 10 進** | **無い** | **足す** |
| **文字列 → ゾーン 10 進** | **無い** | **足す** |

**`number` を経由しない。** 既存の読み取りが文字列を返すのは、`number` が 2^53 を超えると
静かに誤るため（`db-decimal.ts` の注記）。書く向きも同じ方針に揃える
——揃えないと、往復で値が変わる。

### D3: 変換は純関数（`@ts5250/hostserver` の中）

Node API に依存しない。スクリプトからも MCP からも同じものを使う。

### D4: 実機は `QCMDEXC` から通す

用意が要らない標準プログラムで、**文字 in ＋ 詰め 10 進 in** をそのまま使う。
出力の往復は小さな RPG を作って確かめる。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `hostserver/src/db/db-decimal.ts` | **書く向き**を足す（読む向きの隣） |
| `hostserver/src/command/program-args.ts` | **新規**——型付き引数 ↔ `ProgramParameter` |
| `server/src/host-program.ts` | **新規**——REST |
| `server/src/host-server-tools.ts` | MCP ツール |
| `web-ui` | 導線 |

## インターフェース / データ構造

```ts
/** 呼び出し 1 引数。**`dir` の既定は `in`** */
export type ProgramArg =
  | { type: "char"; dir?: Dir; value?: string; length: number }
  | { type: "packed"; dir?: Dir; value?: string; digits: number; decimals?: number }
  | { type: "zoned"; dir?: Dir; value?: string; digits: number; decimals?: number }
  | { type: "bin"; dir?: Dir; value?: string; bytes: 2 | 4 | 8 }
  | { type: "bytes"; dir?: Dir; value?: string /* base64 */; length: number }
  | { type: "null" };

/** 型付き引数 → 下位層のパラメータ */
export function toProgramParameters(args, opts: { ccsid: number }): ProgramParameter[];
/** 下位層の出力 → 型に従った値（**文字列で返す**） */
export function fromProgramOutputs(args, outputs, opts: { ccsid: number }): (string | undefined)[];
```

## 振る舞いの詳細

| 状況 | 結果 |
|---|---|
| `dir` 省略 | `in` |
| `in` に `value` が無い | `CONFIG_ERROR`（**黙って空で送らない**） |
| `char` の `value` が `length` より短い | **空白で埋める**（5250 / IBM i の作法） |
| `char` の `value` が長い | `CONFIG_ERROR`（**黙って切らない**） |
| `packed` の桁あふれ | `CONFIG_ERROR` |
| 出力（`out` / `inout`） | 型に従って**文字列**で返る |
| `null` | そのまま渡す（出力は `undefined`） |

## ドメイン固有の考慮

- **CCSID は接続のものに従う**（文字パラメータ）。取り違えると静かに化ける
- **数値は文字列で受け渡す**（`number` を経由しない。D2）
- ライブラリは明示（`*LIBL` も書ける）

## エラー処理 / 異常系

- プログラムが失敗 → `CommandResult` のメッセージをそのまま返す（既存の形）
- 変換の誤り → `CONFIG_ERROR`（利用者が直せる）
- **黙って詰めない・黙って切らない**——どちらも静かに誤った値を渡すことになる

## 受け入れ基準との対応

| 完了条件 | どう満たすか |
|---|---|
| MCP から呼べる | `host_call_program` |
| 出力が型に従って読める | `fromProgramOutputs` |
| REST から同じ | `POST /api/host/program` |
| web-ui から呼べる | 導線を足す |
| 実機で往復 | `QCMDEXC` ＋ 小さな RPG |
| 失敗が読める | `CommandResult` のメッセージ |
