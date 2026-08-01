# 要件: LOB 表示まわりの follow-up 3 件

## 背景 / 課題

`20260801-sql-lob-failed-state`（PR #240）の review ラウンド 1 で挙がった nit 3 件。
**いずれもその work の変更前から存在**し、差分の焦点を保つため follow-up に据え置いた
（同 work の `review.md` / PR #240 の「follow-up」節）。まとめて片付ける。

### 1. `isLob` の型宣言が実態と食い違う

```ts
// packages/web-ui/src/csv.ts:11
export function isLob(value: unknown): value is { …; value?: string; unavailable?: string } {
```

`value` は宣言では `string` だが、**実態は `string | Uint8Array | undefined`**
（`packages/hostserver/src/db/db-decode.ts:32`。未知の CCSID の LOB は
`decodeLob` がバイト列のまま返す）。`unavailable` も実態は 3 値の union なのに `string`。

食い違いのせいで**呼び出し側が型ガードを信用できず、`as` で読み直している**:

```ts
// csv.ts:21 —— ガードで絞ったはずの value を、もう一度キャストして読む
const v = (value as { value?: unknown }).value;
```

`SqlResultTable.vue:78,89` も同じ理由で `v as { … }` から始めている。

### 2. CSV は打ち切りを無印で出す

`escapeField` は「値が文字列ならその文字列」を返すため、**`too-large`（上限で打ち切った）
LOB が完全な値のように CSV に出る**。画面は `…（以降省略）` を付けて区別している
（`SqlResultTable.vue:81`）。**同じ表を落としたのに、CSV だけ打ち切りが分からない。**

### 3. `SqlPane.vue` の未使用 import

`packages/web-ui/src/components/SqlPane.vue:8` が `isLob` を import しているが
**テンプレートを含めどこからも使っていない**。

## 目的 / ゴール

LOB の表現が「画面・CSV・型」の 3 か所で食い違っている状態を揃える。
特に **CSV が打ち切りを黙る**のは PR #240 が直した `failed` と同じ種類の欠陥
（利用者に実態と違う印象を与える）なので、同じ基準で直す。

## スコープ

### 対象

- `isLob` の型宣言を実態に合わせ、呼び出し側の `as` キャストを外す
- CSV に打ち切りの印を出す
- 未使用 import の削除
- 上記を固定するテスト

### 対象外

- **LOB 取得経路そのもの**（往復数の削減・ロケーターの解放）——backlog の別項目
- **画面表示の文言変更**（`(LOB: 大きすぎます)` / `…（以降省略）` は変えない）
- `hostserver` 側の型（`LobPlaceholder`）の変更——実態が正しいのは向こう

## 機能要件

- `isLob` の述語型が `LobPlaceholder` の実態と一致する（`value?: string | Uint8Array`、
  `unavailable?: "not-requested" | "too-large" | "failed"`）
- `csv.ts` / `SqlResultTable.vue` が LOB を読むのに `as` キャストを使わない
- CSV で `too-large` の LOB が**打ち切られたと分かる**。中身は落とす（捨てない）
- `not-requested` / `failed` / 取得成功・NULL の CSV 表現は**変えない**
- 画面の表示は**一切変えない**

## 非機能要件 / 制約

- **web-ui は hostserver の型を実体から `import type` する**規約がある（AGENTS.md）。
  `@as400web/hostserver` は web-ui の **devDependencies**（`import type` は実行時コードを
  出さないのでバンドルに入らない）。**`dependencies` に移してはならない**
- Excel で開く前提（BOM 付き UTF-8 / CRLF）を崩さない
- 既存テストを壊さない

## 完了条件 (受け入れ基準)

- [ ] `isLob` の述語型に `Uint8Array` と `unavailable` の 3 値 union が含まれる
- [ ] `csv.ts` と `SqlResultTable.vue` から LOB 読み出しの `as` キャストが消える
- [ ] CSV で `too-large` の LOB に打ち切りの印が付く（テストで固定）
- [ ] `not-requested` / `failed` / 取得成功 / NULL の CSV 表現が変わらない（既存テストが通る）
- [ ] `SqlPane.vue` に未使用 import が無い
- [ ] `npm run build` / `npm run lint` / `npm test` が通る

## 未確定事項 / 確認したいこと

- **CSV の打ち切り印の形**。画面と同じ `…（以降省略）` にするか、`(LOB: …)` の族に寄せるか。
  Excel のセルに入る文字なので、値と紛れない形が要る。**spec で決める**
- **型を `@as400web/hostserver` から `import type` するか、web-ui 内で書き直すか**。
  規約は前者だが、`csv.ts` は現在 hostserver に依存していない。**spec で決める**
