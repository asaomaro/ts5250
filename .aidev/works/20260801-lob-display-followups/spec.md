# 仕様: LOB 表示まわりの follow-up 3 件

## 概要

型を実体に合わせ（→ `as` キャストが不要になる）、CSV に打ち切りの印を出し、未使用 import を消す。
**型を直すと CSV の欠落が自然に見える**ので、この順で組む。

## 設計方針

### D1: 型は `@as400web/hostserver` から `import type` する（構造型を web-ui に書き直さない）

AGENTS.md の「**使うものは在り処から取る**」「web-ui はホストサーバーの型を実体から
`import type` する」に従う。先例が既にある（`ifsApi.ts:13` の `IfsEntry` /
`TransferPane.vue:11` の `UploadRejection` / `dtaqApi.ts`）。
`@as400web/hostserver` は web-ui の **devDependencies** で、`import type` は実行時コードを
出さないためバンドルにも本番インストールにも入らない（**`dependencies` に移さない**）。

**`LobPlaceholder` を hostserver の index から公開する**必要がある。現在は
`DbValue` だけが出ている（`packages/hostserver/src/index.ts:48`）が、
`DbValue = string | number | bigint | null | LobPlaceholder` なので
**LobPlaceholder 無しでは DbValue を意味のある形に絞れない**。既存の型 export 行に足す。

```ts
// packages/hostserver/src/index.ts:48
export type { ColumnMeta, DbValue, LobPlaceholder } from "./db/db-decode.js";
```

```ts
// packages/web-ui/src/csv.ts
import type { LobPlaceholder } from "@as400web/hostserver";

export function isLob(value: unknown): value is LobPlaceholder {
  return typeof value === "object" && value !== null && (value as { kind?: string }).kind === "lob";
}
```

**採らなかった案**: web-ui 側で構造型を正しく書き直す。同じ形を 2 か所に置くと
**また食い違う**——今回直しているのはまさにその食い違いなので、根を断つ。

### D2: CSV の打ち切りは画面と同じ `…（以降省略）` にする

`csv.ts` の冒頭が設計原則を宣言している——「**画面に出ている表をそのまま落とす**のが
利用者の期待とも一致する」。ならば打ち切りの見せ方も画面（`SqlResultTable.vue:81`）に揃える。

| 状態 | 画面 | CSV（本 spec 後） |
|---|---|---|
| 取得成功（文字列） | 中身 | 中身 |
| `too-large` | `中身…（以降省略）` | **`中身…（以降省略）`** ← 変更 |
| `not-requested` | `(LOB)` | `(LOB)` |
| `failed` | `(LOB: 取得失敗)` | `(LOB: 取得失敗)` |

**採らなかった案**: `(LOB: 大きすぎます)` に置き換える。**取れた分を捨てることになる**。
CSV を落とす目的は中身を持ち出すことなので、印のために本文を消すのは本末転倒。

**エスケープは印を付けた後の文字列に掛ける**（`escapeField(v + マーカー)`）。
マーカー自体は `,` `"` 改行を含まないので結果は同じだが、
**後でマーカーを変えたときに壊れない**書き方にしておく。

### D3: バイナリ LOB（`Uint8Array`）の扱いは変えない

型を直すと `value?: string | Uint8Array` が見えるようになり、分岐が明示される。
**現状の挙動は維持する**——文字列でない値は `(LOB)`（画面も同じ）。

ただしこれは「取得に成功したバイナリ LOB」も `(LOB)` と出す＝
**未取得と区別が付かない**という、`failed` と同じ種類の欠陥を残す。
本 work の requirement は 3 件に絞っているので**直さず、コメントで所在を明示**し
follow-up として PR に書く（BLOB の実機検証が backlog に残っており、
実物を見てから決める方が確か）。

### D4: `SqlResultTable.vue` の `as` も外す

`csv.ts` だけ直して `SqlResultTable.vue:78,89` に `as` が残ると、
「型ガードは信用できない」という誤った前例が残る。同じ `isLob` を通す形に揃える。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/hostserver/src/index.ts:48` | `LobPlaceholder` を型 export に追加 |
| `packages/web-ui/src/csv.ts:11` | `isLob` の述語を `LobPlaceholder` に。`as` を外す。打ち切りの印（D2） |
| `packages/web-ui/src/components/SqlResultTable.vue:76-96` | `lobText` / `lobTitle` の `as` を外す |
| `packages/web-ui/src/components/SqlPane.vue:8` | 未使用 import `isLob` を削除 |
| `packages/web-ui/test/csv.test.ts` | 打ち切りのテストを追加 |

## 振る舞いの詳細

- CSV: `too-large` かつ `value` が文字列 → `中身…（以降省略）`
- CSV: それ以外は現状どおり（`failed` → `(LOB: 取得失敗)` / 他 → `(LOB)`）
- 画面: **変更なし**
- `isLob` の実行時の判定ロジックは**変えない**（`kind === "lob"` のまま）。型注釈だけの変更

## ドメイン固有の考慮

- **`import type` を `dependencies` に昇格させない**（AGENTS.md。バンドルに `node:net` を
  引き込んだ前例がある）。`package.json` は触らない
- **`packages/server/test/import-from-owner.test.ts`** が「使うものは在り処から取る」を
  走査で固定している。`@as400web/hostserver` から直接取る形はこれに沿う
- Excel 前提（BOM 付き UTF-8・CRLF）は変えない

## エラー処理 / 異常系

- 型の変更のみで実行時の分岐は増えない。`isLob` が `true` を返す値の形が
  実際に `LobPlaceholder` と違っていても（サーバーが古い等）、各分岐は
  `undefined` 側へ落ちるだけで例外にはならない（現状と同じ）

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| 述語型に `Uint8Array` と 3 値 union | D1（`LobPlaceholder` をそのまま使う） |
| `as` キャストが消える | D1 / D4 |
| CSV に打ち切りの印 | D2＋`csv.test.ts` |
| 他の CSV 表現が変わらない | 既存テスト（PR #240 で入れた 5 件）が通る |
| 未使用 import が無い | `SqlPane.vue:8`＋`npm run lint` |
| build / lint / test | 一式を実行 |

## 未確定事項

なし（requirement の未確定 2 件は D1 / D2 で解消）。
