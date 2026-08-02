# 仕様: SQL 結果表を仮想化し、列幅を文字数から決める

## 概要

**セルを作る仕事が律速**（1 セル ~14 µs・セル数に正比例。research F2）なので、
効くのは「**セルを作らない**」ことだけ。表示範囲だけ描く。

行を間引くと `table-layout: auto` が幅を決められなくなるので、
**幅を先に決めて宣言する**（`fixed`）。等幅・折り返しなしなので**文字数から計算できる**（F4）。

| | いま | これから |
|---|---|---|
| 描くセル | 全部（1000 行 × 40 列 ＝ 40,000） | **見える範囲＋余白のみ**（約 2,400） |
| 列幅 | `auto` が全行から決める | **全行の文字数から計算**して宣言 |
| レイアウト | `table-layout: auto` | `table-layout: fixed` |

## 設計方針

### 1. 幅は「全行の表示幅の最大」から計算する（標本にしない）

先頭 N 行だけ見て決めると、**後ろにある長い値で列が足りなくなる**——いまの見え方が変わる。
全行を走査するが、**文字数を数えるだけ**なので描画より 2 桁安い。

```ts
// 純粋関数。DOM を触らないので単体で固定できる
columnCharWidths(columns, rows, cellText): number[]   // 表示幅（半角換算）
```

- 全角は 2 幅（`isFullWidth`＝`@as400web/base`。既存の判定を使う）。
- **ASCII だけの文字列は `length` で済ませる**（1 文字ずつ判定しない）。
  40,000 セル × 十数文字を走るので、ここが遅いと本末転倒。
- **セルの文字は表示に使うものと同じ**。`NULL` は `"NULL"`、LOB は `lobText()` の結果。
  そのために **`cellText()` を 1 本に切り出し、テンプレートと幅計算の両方が使う**
  ——2 か所で別々に決めると、幅と中身が食い違う。

### 2. 文字幅の px は**1 回だけ実測**する

`th`（12px）と `td`（13px）でフォントサイズが違うので **`ch` 単位は使えない**（F4）。
`td` に見えない探り棒を 1 つ置いて 1 文字ぶんの px を測り、以後は掛け算だけ。

```
width(px) = ceil(chars * charPx) + CELL_PADDING
```

**測れない環境（jsdom）では既定値へ落とす**（`FALLBACK_CHAR_PX`）。
テストで固定するのは**文字数のほう**で、px 換算は実ブラウザで確かめる。

### 3. 上限を入れる（**意図した挙動変更**）

いま `SqlResultTable` に `max-width` は無く（F5）、長い値がそのまま列幅になる。
1 セルに数千文字の CLOB が来ると、**その 1 列で画面が埋まり他の列に辿り着けない**。

**上限 120 文字**（`MAX_COL_CHARS`）を入れる。超えた列は切り詰めて `…` を出し、
**ドラッグで広げられる**（`useColumnWidths` は `max-width` ごと上書きする）。

> これは今回**唯一の意図的な見え方の変更**。PR 本文に明記する。
> `TransferPane` は既に `max-width: 40ch` で同じ扱いをしているので、
> アプリの中では新しい概念ではない。

### 4. 仮想化の位置計算は純粋関数に切り出す

```ts
visibleWindow(scrollTop, viewportH, rowH, total, overscan, headerH): { start, end }
```

- `start = clamp(floor((scrollTop - headerH) / rowH) - overscan)`
- `end = clamp(ceil((scrollTop - headerH + viewportH) / rowH) + overscan)`
- **行高は揃っている**（等幅・折り返しなし・固定フォントサイズ。F4）ので掛け算で足りる。
  実測 1 回（`FALLBACK_ROW_PX` へ落とす）。

**上下に詰め物の行**を置いて、スクロールできる高さを保つ:

```html
<tr class="spacer" :style="{ height: start * rowH + 'px' }"><td :colspan="n"></td></tr>
… 見える行 …
<tr class="spacer" :style="{ height: (total - end) * rowH + 'px' }"><td :colspan="n"></td></tr>
```

- スクロールバーの長さが**全行数を反映**する（掴んだ位置と中身が合う）。
- `tbody tr:hover` は `:not(.spacer)` に絞る（詰め物が光らないように）。
- 再計算は **`requestAnimationFrame` で間引く**（1 スクロールごとに描き直さない）。

### 5. 行番号は**通し番号**を渡す

`start + i + 1`。間引いてもずれない（受け入れ基準）。

### 6. 既存の約束を壊さない

| 約束 | どう保つか |
|---|---|
| 手動リサイズ | `widthStyle(i) ?? computedStyle(i)` の順で当てる。ドラッグ中も同じ |
| ダブルクリックで戻す | `cols.reset(i)` で手動ぶんを捨て、計算値へ戻る（「中身に合わせる」の意味は保たれる） |
| 下端で読み足し | `onScroll` はそのまま（詰め物で高さが正しいので判定も正しい） |
| End / PageDown | そのまま |
| タブを戻したときのスクロール位置 | `onActivated` で当てたあと、**窓を再計算する** |
| 行が増えたとき（読み足し） | 幅を計算し直す（**新しい行に長い値がありうる**）。窓も再計算 |

## 対象範囲

| ファイル | 変更 |
|---|---|
| `composables/tableVirtual.ts`（新規） | `visibleWindow` / `columnCharWidths` / `displayWidth`（純粋） |
| `components/SqlResultTable.vue` | 仮想化・幅の宣言・`cellText` の切り出し・CSS（`fixed`・詰め物・省略） |
| `test/sql-table-virtual.test.ts`（新規） | 窓の計算・幅の計算・行番号 |
| `scripts/research-sql-table-render.mjs`（作成済み） | 基準線 |
| `scripts/verify-sql-table-virtualize.mjs`（新規） | 前後の実測・幅が動かないこと |

**`useColumnWidths.ts` は触らない**（`SpoolPane` / `TransferPane` と共有）。
今回の計算値は `SqlResultTable` 側で持ち、手動指定が来たらそちらを優先する。

## インターフェース / データ構造

```ts
/** 半角換算の表示幅。全角は 2（ASCII だけなら length で済ませる） */
export function displayWidth(s: string): number;

/** 列ごとの表示幅（見出しを含む）。`cellText` は表示に使うのと同じ関数 */
export function columnCharWidths<R>(
  headers: string[],
  rows: readonly R[],
  cellText: (row: R, col: number) => string,
  maxChars: number
): number[];

/** 描く範囲。`headerH` は sticky な見出しのぶん */
export function visibleWindow(
  scrollTop: number, viewportH: number, rowH: number,
  total: number, overscan: number, headerH: number
): { start: number; end: number };
```

## 振る舞いの詳細

- 行が 0 のときは詰め物も出さない（従来どおり空の tbody）。
- `total` が窓より小さければ全部描く（`start=0` / `end=total`）。
- `rowH` が測れない（0）ときは `FALLBACK_ROW_PX` を使い、**全行描く**方へ倒す
  ——間引きに失敗して行が消えるより、遅いほうがまし。
- 幅の再計算は `columns` か `rows.length` が変わったときだけ（スクロールでは走らせない）。

## エラー処理 / 異常系

- 探り棒で幅が測れない → `FALLBACK_CHAR_PX`。表は出る（テスト環境の既定経路）。
- 極端に長い値 → 上限で切り、`title` に全文（既存の `cellTitle`）。
- `scrollTop` が負・過大 → `clamp` で吸収。

## ドメイン固有の考慮

- **全角を 1 幅で数えない。** 日本語の列が半分の幅になる（この repo で何度も踏んでいる形）。
- 実機（）は共用の本番機。**表を作らない**——`QSYS2.SYSCOLUMNS` から行を取る。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 前後の初回描画を実測し改善が出る | 方針 4（verify スクリプトで 200 / 1000 行） |
| スクロールで列幅が変わらない | 方針 1〜3（宣言した幅・`fixed`） |
| スクロールバーが全行を反映 | 方針 4（詰め物） |
| 手動リサイズ・戻す・読み足し・位置保持 | 方針 6 |
| データ転送ペインが壊れない | `useColumnWidths` を触らない＋既存テスト |
| 単体で窓と行番号を固定 | 方針 4・5（純粋関数） |
