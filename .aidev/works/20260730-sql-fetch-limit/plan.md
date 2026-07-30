# 計画: 取得する行数を実際に抑える（早期打ち切り）

## 実装方針

**core から積む**（上限つき取得 → MCP → REST）。subtask には割らない（4 ファイル・1 機能）。

`queryLimited` は `openQuery` の上に薄く乗せる——`fetchAll` や `closeCursor` を触らない。
既存の全件取得（`query`）と画面のページングは**変更しない**ので、
回帰の範囲は「新しい入口を使う 2 経路」に閉じる。

## 作業順序と依存関係

1. `queryLimited()`（core）＋テスト（依存: なし）
2. `core/index.ts` で公開（依存: 1）
3. MCP `host_sql` を載せ替え、**説明文を実態に合わせる**（依存: 2）
4. `/api/host/sql` の単発経路を載せ替え（依存: 2）
5. テスト（server 側。往復回数と `truncated` の意味）（依存: 3・4）
6. 実機で最終確認（`research-sql-cancel.mjs` は済。MCP 経路を 1 度通す）（依存: 5）
7. 空振り検証・文書（backlog 2 項目・`scripts/README.md`・decisions）（依存: 6）

## リスク / 留意点

- **`limit + 1` の余りを返してしまう**のが一番ありそうな間違い（上限を 1 行超える応答）。
  境界（ちょうど・+1）をテストで固定する
- **ブロックを上限に合わせすぎない**（上限が既定 100 を超えるときは既定のまま。research F3）
- **LOB を落とさない**（`fillLobs` を通す。打ち切り後・カーソルを閉じた後）
- `truncated` の**意味が変わる**（応答で切った → 取得を打ち切った）。
  MCP の説明文と `host-sql.ts` のコメントを同時に直す（腐らせない）
- `limit <= 0` を黙って全件にしない

## テスト方針

- `core`: 偽の接続で **fetch の往復回数**とブロッキング係数の値を見る／
  境界（0 行・上限未満・ちょうど・+1）／`limit <= 0`／LOB を通すこと
- `server`: `host_sql`（MCP）と `/api/host/sql` が**上限を core へ渡している**こと／
  `truncated` が応答に出ること
- 実機: `research-sql-cancel.mjs`（済）＋ MCP 経路を 1 度通して往復回数を確認

## 空振り検証（mutation）

- `limit + 1` ではなく `limit` だけ読む（ちょうどのときに `truncated` が嘘になる）
- 余りの 1 行を捨てない（上限を 1 行超える）
- `truncated` を `rows.length === limit` で決める
- ブロッキング係数を既定固定にする（小さい上限で無駄が残る）
- ブロッキング係数を `limit + 1` 固定にする（大きい上限で 1 往復が膨らむ）
- `limit <= 0` を全件にする
- LOB の解決を落とす
- MCP が `query`（全件）に戻る
