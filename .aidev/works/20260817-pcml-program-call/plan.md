# 計画: プログラム界面を「記述」から駆動する

## 順序

下から積む。**各段で実機かテストで確かめてから次へ行く**。

| # | 段 | 中身 | 確かめ方 |
|---|---|---|---|
| 1 | 解析 | `pcml-parse.ts`——`.pcml` → 木。`usage` の継承と `struct` の解決まで | 実測の PCML を固定資料にして単体テスト |
| 2 | 符号なし | `program-args.ts` の `bin` に `signed?` | 単体テスト（既存は無変更で通ること） |
| 3 | 平坦化 | `pcml-layout.ts`——木 → `ProgramArg` 列、名前 ↔ 値 | 単体テスト（構造体・配列・可変長） |
| 4 | REST | `host-pcml.ts` 2 本 | 偽の接続で単体テスト |
| 5 | 実機 | `scripts/verify-pcml.mjs` | **実機で往復** |
| 6 | 画面 | `PcmlPane.vue` ＋ 導線 | 単体テスト ＋ **実ブラウザ** |

## 1. 解析（`pcml-parse.ts`）

- タグは `pcml` / `struct` / `program` / `data` の 4 つだけ扱う。
  **知らないタグは黙って飛ばさず、位置つきで拒否する**（`XPCMLHelper` の類を誤読しないため）
- 属性は `research.md` B の表に従う。**知らない属性は無視**（PCML の版差で落ちないように）
- コメント `<!-- … -->` と XML 宣言を飛ばす
- **`usage` の継承はここで解く**（下流に `inherit` を漏らさない）
- **`struct` 参照はここで解く**（循環は位置つきで拒否）

固定資料: `packages/hostserver/test/fixtures/pcmltst.pcml`（**A の実測そのもの**）と、
手書きの可変長配列の例（実機 API の PCML に相当するもの）。

## 2. 符号なし整数

```ts
| { type: "bin"; dir?; value?; bytes: 2 | 4 | 8; signed?: boolean }   // 既定 true
```

`encodeBin` / `decodeBin` に符号なしの枝を足す。**既定を今の挙動にする**ので既存は無変更。

## 3. 平坦化（`pcml-layout.ts`）

```ts
buildCall(doc, program, values): { args: ProgramArg[], plan: FieldSlot[] }
readCall(plan, outputs): Record<string, string>
```

- `FieldSlot` は「完全名 → 何番目の引数の、どの位置から何バイト」
- **入力が足りない場合**: `usage=input`/`inputoutput` で値も `init` も無ければ拒否
- **`count` が名前**: その項目の入力値から件数を決める。決まらなければ拒否（D6）
- 構造体・配列は `bytes` 1 本に畳んで、中身はこの層で詰める／解く

## 4. REST（`host-pcml.ts`）

`host-program.ts` の作りに揃える（`resolveSource` / `openCommand` / `finally` で閉じる）。
IFS から読む枝だけ `IfsConnection` を使う。

## 5. 実機（`scripts/verify-pcml.mjs`）

`research` で作った `TESTLIB/PCMLTST` を、**今度は PCML 経由で**呼ぶ。
`research-pcml-layout.mjs` と**同じ値・同じ判定**にして、
「手詰めでできたことが、名前でもできる」を示す。

可変長配列は `PCMLTST` では試せない（RPG の `dim` は固定）ので、
**手書きの `.pcml`** を同じプログラムに当てて `count="CNT"` を測る。

## 6. 画面（`PcmlPane.vue`）

- `.pcml` の入力は **IFS の道**か**貼り付け**
- 「読み込む」で `/parse` → 項目を並べる（構造体は入れ子、配列は件数ぶん）
- `usage=output` は**入力させない**（読むだけ）
- 「呼ぶ」で `/call` → 名前つきで結果を出す

## 危ないところ

| 危険 | どうするか |
|---|---|
| 桁ずれが黙って通る | 長さ・桁・件数が合わなければ**必ず拒否**。既定で埋めない |
| 可変長配列で領域外 | 件数が決まらなければ呼ばない（D6） |
| `.pcml` の CCSID 取り違え | 実測どおり **819** を既定にし、タグがあればそれを優先 |
| 既存 4,000 件を壊す | `bin` の `signed?` は**既定が今の挙動**。他は新規ファイル |
| 実機の後片付け | `PCMLTST` は `TESTLIB` に残す（他の試験片と同じ扱い） |

## 見積もり

新規 4 ファイル ＋ 変更 5 ファイル。実機の測定は 2 本とも**済んでいる**ので、
残りは実装と、往復 1 本、ブラウザ 1 本。
