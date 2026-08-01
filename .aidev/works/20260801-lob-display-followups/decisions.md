# 自律実行中の判断記録

## D1: `tsc -b` では足りない——`vue-tsc` を回す（coding 工程）

**背景**: 型を実体に寄せたあと `npm run build`（＝`tsc -b`）が通ったので、いったん緑と見なしかけた。
だが `tsc -b` は **SFC のテンプレートを型検査しない**。web-ui は自前の build スクリプトで
`vue-tsc -b tsconfig.json tsconfig.test.json` を回している（`packages/web-ui/package.json`）。

**判断**: `vue-tsc` を明示的に実行して確認する。

**結果**: **本物のエラーが 2 種類出た**（`tsc -b` は素通りしていた）。

1. `SqlPane.vue(660,10) TS2719` — `Row[]` を prop で渡せない。「同名だが無関係な 2 つの型」。
   `SqlPane.vue:36` が**自分の `Row` を持っており**、その LOB が `{ kind: "lob" }` のまま
   だったため、`SqlResultTable` 側の `Cell`（`LobPlaceholder` に変更済み）と構造が食い違った
2. `SqlResultTable.vue(143,77 / 143,100) TS2345` — `r[c.name]` は `Cell | undefined`
   （インデックスアクセスが undefined を含む設定）。引数を `unknown` から `Cell` に狭めたことで顕在化

**教訓**: web-ui に型の変更を入れたら `tsc -b` の緑を信用しない。**`vue-tsc` まで回す**。

## D2: スコープが 1 ファイル増えた（`SqlPane.vue` の `Row`）

requirement は `SqlPane.vue` について「未使用 import の削除」しか挙げていなかったが、
D1 の 1 番のエラーにより **同ファイルの `Row` 型も `LobPlaceholder` に寄せた**。

**理由**: これは requirement が直そうとしている歪みそのもの——「同じ構造型が 2 か所にあり、
実態と食い違う」。`csv.ts` と `SqlResultTable.vue` だけ直して `SqlPane.vue` に
`{ kind: "lob" }` を残すと、**型が繋がらず prop を渡せない**（コンパイルが通らない）。
選択の余地なく、かつ requirement の趣旨に沿う。

## D3: `isLob` の中の `as` は残す

`csv.ts:18` の `(value as { kind?: string }).kind` は**型ガード自身の実装**で、
`unknown` から判別子を読むために必要。requirement が問題にした
「ガードで絞ったのに呼び出し側がもう一度キャストする」とは別物なので残す。

## D4: バイナリ LOB の表示は直さない（観察のみ記録）

型を正したことで `value?: string | Uint8Array` が見えるようになり、
**取得に成功したバイナリ LOB も `(LOB)` と表示され未取得と区別が付かない**ことが
コード上で明確になった。`failed` と同じ種類の欠陥だが、

- requirement のスコープ（follow-up 3 件）の外
- backlog に「BLOB（バイナリ）と中身のある DBCLOB での検証」が**別項目として残っている**。
  実物を見てから決める方が確か

ため直さず、`csv.ts` に ⚠ コメントで所在を明示し、PR の follow-up に書く。
