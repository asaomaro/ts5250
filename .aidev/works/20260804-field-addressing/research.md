# 調査: 欄の指し方

## 調査の問い

- Q1: `Field` はどこで作られるか。id を足す場所は
- Q2: 共有層はどこに置けるか（`@ts5250/tn5250` は Node API 非依存を保てるか）
- Q3: `hllapi-ps.ts` の関数は HLLAPI 固有（バイト依存）か、持ち上げられるか
- Q4: **`(row,col)` は本当に一意か**（これが設計の前提）

## 判明した事実

### F1: `Field` は 1 箇所で作られ、`row`/`col` は既に手元にある

`packages/tn5250/src/screen/buffer.ts:922-932`:

```ts
const fields: Field[] = this.orderedFields().map((f, i) => {
  const { row, col } = this.rowColOf(f.startAddr);
  ...
  const field: Field = { index: i + 1, row, col, ... };
```

**id を足すのは 1 行。** `Field` は `WsScreen` で web-ui まで、`structuredContent` で MCP まで
そのまま流れるので、**追加の配線が要らない**。
MCP の出力スキーマは `.passthrough()` 済み（`20260803-hllapi-bridge`）なので壊れない。

### F2: `screen/` に Node API 依存は無い

`node:` を import しているのは `transport/tcp.ts` だけ。
**`screen/` に検索の共有層を置ける**（PJ 規約を保てる）。

### F3: `hllapi-ps.ts` は**きれいに割れる**

| 関数 | 何に依存するか | 扱い |
|---|---|---|
| `posToRowCol` / `rowColToPos` / `psLength` | **桁位置だけ** | 持ち上げる |
| `fieldAt` / `fieldStart` / `isInputField` / `nextInputField` / `prevInputField` | **桁位置だけ** | 持ち上げる |
| `psBytes` / `psSlice` / `psSearch` / `fieldBytes` | **CP932 のバイト列** | HLLAPI 固有。据え置く |

CP932 では 1 桁 = 1 バイトなので上段は実質「桁位置の計算」。**HLLAPI 固有ではない。**

ただし**文字列での検索は別に要る**——スクリプトは JS の文字列で「ユーザー」を探したいが、
`psSearch` は CP932 のバイト列を比べる。**同じ関数にはできない**（用途が違う）。

### F4: `(row,col)` は実機で一意（**8 画面・49 欄・重複 0**）

実機で実測（サインオン / MAIN / WRKSPLF / WRKACTJOB / DSPLIBL / WRKOBJ / GO CMDIFS / WRKUSRPRF）:

```
画面 8 枚 / 欄 49 個（最大 12 個/画面）→ (row,col) の重複 0 件
```

構造上も、欄は**開始位置（属性バイトの次の桁）で定義される**のでぶつからないはず。
ただし**「はず」で済ませない**——不変条件として検査を置く。

> 手元のフィクスチャでは 4 画面・6 欄しか通せず、根拠として弱かった。実機で数え直した。

### F5: web-ui は既に DOM 属性を出している。ただし **1 欄 : N input**

`ScreenGrid.vue:3393`:

```html
<input class="grid-input" :data-field-index="seg.field!.index" :data-slice="seg.slice ?? 0" ...>
```

行をまたぐ欄は分割して描かれる。**id は欄を指し、`slice` は別属性のまま残す。**

## 影響範囲

- `packages/tn5250/src/screen/types.ts` — `Field.id`
- `packages/tn5250/src/screen/buffer.ts` — 1 行
- `packages/tn5250/src/screen/search.ts`（新規）— 桁位置・欄・**文字列検索**
- `packages/server/src/hllapi-ps.ts` — 持ち上げた分を再輸出して使う
- `packages/web-ui/src/components/ScreenGrid.vue` — 属性 1 つ

## 実現性 / リスク

- **低リスク。** `Field` への追加のみで、既存の属性を変えない
- リスクは **`hllapi-ps.ts` の持ち上げで HLLAPI を壊すこと** → 実機 33/33 で確かめる
- 一意性は実測で裏が取れた。**検査で固定**して回帰を防ぐ

## spec への申し送り

- id は**位置由来だと読んで分かる形**にする（意味的な安定を主張しない）
- 検索は**文字列版を新規に書く**（バイト版とは別物。用途が違う）
- **厳格モード**（曖昧なら例外＋候補）。`nth` は作らない
- `hllapi-ps.ts` は**再輸出**にして、HLLAPI の呼び出し側を触らない
