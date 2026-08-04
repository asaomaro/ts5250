# 仕様: 欄の指し方

## 概要

**2 層に分ける。**

1. **機械的な id**（`(row,col)` 由来）— 決定的・画面内で一意。DOM のセレクタと重複検出に使う
2. **意味的な指定**（ラベル錨の検索）— レイアウト変更に耐えるのはこれだけ

id は**意味的な安定を主張しない**。5250 は欄の名前を電文で運ばないので、
導出した id はどれもレイアウト変更で変わる。**壊れ方を局所に留める**のが狙い。

## 設計方針

### D1: id は `f<row>c<col>`

例: 20 行 7 桁の欄 → **`f20c7`**。

- **位置由来だと読んで分かる**。`field-3` のような名前だと意味的に安定だと誤解される
- 連番にしない——`Field.index` の脆さがこの作業の動機
  （手前の欄が 1 つ増減すると全部ずれる。`(row,col)` は**その欄が動いたときだけ**変わる）
- 桁を 0 埋めしない。`f20c7` のほうが読みやすく、機械は完全一致で使う

### D2: 検索は文字列版を新規に書く

`psSearch` は CP932 のバイト列を比べる（HLLAPI が 1 位置 = 1 バイトを要求するため）。
スクリプトは JS の文字列で探したい。**同じ関数にはできない**ので、
`screen/search.ts` に**文字ベースの検索**を置く。

`fieldAt` / `nextInputField` 等（桁位置だけに依存）は**持ち上げて共有**し、
`hllapi-ps.ts` は再輸出にする——**HLLAPI の呼び出し側を触らない**。

### D3: 曖昧なら例外＋候補一覧

複数当たったら**黙って先頭を取らない**。実機の `WRKSPLF` で

- 1 つの見出し（`OPT`）が **9 個の欄**を支配する
- **行の内容も重複する**（同じスプール名が 2 行）

ことを確認済み。**導出できる一意な鍵は存在しない**ので、曖昧さは利用者に返すしかない。
Playwright の strict mode と同じ判断で、HLLAPI の `Connect` が同名セッションに `rc=11` を
返すのと同じ原則。

### D4: `nth` は作らない

順序依存で事故の元（2026-08-04 に方針決定）。絞り込みは**行の内容・列・領域**で行う。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `tn5250/src/screen/types.ts` | `Field.id` |
| `tn5250/src/screen/buffer.ts` | 1 行（id を組む） |
| `tn5250/src/screen/search.ts` | **新規**——桁位置・欄・文字列検索 |
| `tn5250/src/index.ts` | 公開 |
| `server/src/hllapi-ps.ts` | 持ち上げた分を再輸出 |
| `web-ui/.../ScreenGrid.vue` | `data-field` を出す |

## インターフェース / データ構造

```ts
// Field
/**
 * 画面内で一意な、**位置由来**の識別子（`f<row>c<col>`）。
 * **意味的な安定は主張しない**——欄が動けば変わる。
 */
id: string;

// screen/search.ts
/** 画面上の文字列をすべて探す（1 起点の桁位置） */
export function findAllText(snapshot, text): number[];

/** 曖昧さの説明つきの例外 */
export class AmbiguousMatchError extends Error {
  readonly candidates: { pos: number; row: number; col: number; near: string }[];
}

/**
 * ラベルの**直後の入力欄**を引く。
 * **複数当たれば `AmbiguousMatchError`**（黙って先頭を取らない）。
 */
export function fieldAfterLabel(
  snapshot,
  label: string,
  opts?: { rows?: [number, number]; cols?: [number, number]; sameRow?: boolean }
): Field;

/** 行の内容で欄を引く（一覧の行を指す。複数当たれば例外） */
export function fieldInRowWith(snapshot, text: string, opts?: { col?: number }): Field;

/** 持ち上げ（桁位置だけに依存する既存の関数） */
export function posToRowCol(pos, size): { row; col } | undefined;
export function rowColToPos(row, col, size): number | undefined;
export function screenLength(size): number;
export function fieldAt(snapshot, pos): Field | undefined;
export function fieldStart(field, size): number | undefined;
export function isInputField(f): boolean;
export function nextInputField(snapshot, pos): Field | undefined;
export function prevInputField(snapshot, pos): Field | undefined;
export function fieldById(snapshot, id): Field | undefined;
```

## 振る舞いの詳細

| 状況 | 結果 |
|---|---|
| `fieldAfterLabel(snap, "ユーザー")` — 1 つ当たる | その欄 |
| 同 — 複数当たる | **`AmbiguousMatchError`**（候補の位置と近傍の文字を添える） |
| 同 — 当たらない | `FIELD_NOT_FOUND` |
| 絞り込み（`rows` / `cols` / `sameRow`） | 候補を狭めてから判定 |
| `fieldById(snap, "f20c7")` | 完全一致。無ければ `undefined` |

- **絞り込みは重ねられる**。`{ rows: [12, 20], cols: [1, 5] }` のように併用できる
- 例外のメッセージは**そのまま人が読んで絞り込める**内容にする（候補の行桁と近傍の文字）

## ドメイン固有の考慮

- **1 欄 : N input**。web-ui は `data-field`（欄の id）と `data-slice`（描画の断片）を併記する
- **`fieldSignon` は触らない**。「最初の非 hidden 欄／最初の hidden 欄」と黙って先頭を取るが、
  サインオン画面に特化した便宜として据え置く。**汎用検索の手本にしない**
- HLLAPI の呼び出し側は**変更しない**（`hllapi-ps.ts` の再輸出で吸収する）

## エラー処理 / 異常系

- `AmbiguousMatchError` は `As400Error` ではなく**専用の型**——候補を構造化して持たせるため。
  MCP 経由で使うときは呼び出し側が `FIELD_NOT_FOUND` 等へ写す
- **一意性の破れ**は不変条件の検査で捕まえる（`Field.id` が重複したら気づける）

## 受け入れ基準との対応

| 完了条件 | どう満たすか |
|---|---|
| id が全経路に届く | `Field` に足す。`WsScreen` / `structuredContent` で自動的に流れる |
| 一意性が検査で担保 | フィクスチャ全件＋合成画面で重複が無いことを固定 |
| Playwright が指せる | `data-field` を出す |
| ラベルから引ける | `screen/search.ts`（Node 非依存なので誰からも使える） |
| 曖昧なら例外＋候補 | `AmbiguousMatchError`。実機の `WRKSPLF` の形を検査に写す |
| HLLAPI が壊れない | 再輸出。実機 33/33 |
