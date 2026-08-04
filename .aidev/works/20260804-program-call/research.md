# 調査: プログラム呼び出しを開く

## 調査の問い

- Q1: 下位層は何を受け取り、何を返すか
- Q2: 変換の部品は既にあるか（EBCDIC・詰め 10 進）
- Q3: 接続はどう作るか（既存の CL 実行と同じ経路で行けるか）
- Q4: 実機で何を呼んで確かめるか

## ⚠ 訂正（2026-08-04・実装中に判明）

**F0 と requirement の前提に誤りがあった。**

「MCP にプログラム呼び出しが無い」と書いたが、**あった**——`host_call_program` が
`packages/server/src/host-server-tools.ts:307` に既にある。

`packages/server/src/mcp-tools.ts` を grep して 0 件だったので無いと判断したが、
**ホストサーバー系のツールは別のファイル**（`host-server-tools.ts`）に居る。
5250 セッション系（`mcp-tools.ts`）とホストサーバー系で**ファイルが分かれている**ことを
見落とした。

実装中にこれに気づかず、既存のツールを重複と誤認して**一度削除した**（全件テストで発覚）。

### 訂正後の「本当に足りないもの」

| | 状態 |
|---|---|
| MCP ツール | **あった**（生バイト base64 専用） |
| **型付きの引数**（文字・詰め 10 進） | **無い**——呼ぶ側が EBCDIC と詰め 10 進を自分で組む必要がある |
| REST | 無い |
| web-ui の導線 | 無い |

**この作業の値打ちは「型付きの変換」に絞られる。** 生バイトだけでは、
`QCMDEXC` に長さを渡すだけで詰め 10 進を手で組むことになり、実質使えない。

## 判明した事実

### F1: 下位層は**生バイト**しか扱わない

`command-datastream.ts:230`:

```ts
export type ProgramParameter =
  | { type: "in"; data: Uint8Array }
  | { type: "out"; length: number }
  | { type: "inout"; data: Uint8Array; length: number }
  | { type: "null" };
```

`CommandConnection.call(program, library, params)` は
`{ result: CommandResult; outputs: (Uint8Array | undefined)[] }` を返す（`command-connection.ts:176`）。

**足りないのは変換だけ。** 利用者は文字と数値で書きたいが、いまはバイト列を自分で組む必要がある
——これが「実装済みなのに届かない」の中身。

### F2: 変換の部品は**全部ある**

| 変換 | どこに |
|---|---|
| EBCDIC ↔ 文字 | `@ts5250/ebcdic`（CCSID 別の表つき） |
| 詰め 10 進 | `packedDecimalToString`（`db/db-decimal.ts:30`） |
| ゾーン 10 進 | `zonedDecimalToString`（`db/db-decimal.ts:65`） |
| 詰め 10 進の長さ | `packedByteLength`（`:19`） |

**読む向きは揃っている。書く向き（数値 → 詰め 10 進のバイト列）が無い**ので、そこは足す。

### F3: 接続は既存の経路で行ける

`openCommand(opts)`（`host-connect.ts:50`）が `CommandConnection.connect` を包んでいる。
`host-lists.ts` や `host-server-tools.ts` が同じ形で使っている——**新しい配管は要らない**。

### F4: 実機で確かめる相手

**新しくプログラムを作らなくても始められる。**

| 呼ぶもの | 何を確かめられるか | 用意 |
|---|---|---|
| `QSYS/QCMDEXC` | **文字 in ＋ 詰め 10 進 in**。効果が観測できる（コマンドが実行される） | **不要** |
| 小さな RPG | **out / inout**、数値の往復 | この作業で作る（`build-*.mjs` に前例） |

`QCMDEXC(command char(N), length packed(15,5))` は IBM i の標準で、
**どの機にも必ずある**。最初の 1 本をこれにすると、フィクスチャの用意を待たずに経路を通せる。

## 影響範囲

- `packages/hostserver/src/command/program-params.ts`（新規）— **型付きの変換**
- `packages/server/src/host-program.ts`（新規）— REST
- `packages/server/src/host-server-tools.ts` — MCP ツール
- web-ui — 導線

## 実現性 / リスク

- **低リスク。** 下位層は無改変。足すのは変換と配線
- リスクは**詰め 10 進の書き込み**（符号ニブル・桁合わせ）→ 読み書きの往復を検査で固定する
- CCSID の取り違え（文字パラメータ）→ 接続の CCSID に従う

## spec への申し送り

- 変換は**純関数**（Node API 非依存）にしてスクリプトからも使えるように
- **生バイトの逃げ道を残す**（型で表せない構造体を渡せなくならないように）
- 実機は **`QCMDEXC` を最初に**通す（用意が要らない）
