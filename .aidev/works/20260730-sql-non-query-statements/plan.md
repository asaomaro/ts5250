# 計画: 結果を返さない SQL 文を実行する

## 実装方針

**下から積む**（判定 → core の実行 → server の振り分け → 画面）。
subtask には割らない（7 ファイル・1 機能・契約は応答の `kind` 1 つ）。

`executeStatement` は `insert.ts` の 3 段から `changeDescriptor` を落とした形なので、
**`insert.ts` を書き換えずに新しいファイルへ書く**——あちらは CSV 取り込みが動いており、
共通化のために触ると回帰の範囲が広がる。共通部分（`sqlText` / `identifier` / `num` の
組み立て）は小さいので、重複を許して独立させる。

## 作業順序と依存関係

1. `statement-kind.ts`（純関数）＋テスト（依存: なし）
2. `execute.ts`（`prepareAndDescribe` → `execute`）＋テスト（依存: 1）
3. `core/index.ts` で公開（依存: 2）
4. `host-sql.ts` の振り分け＋テスト（依存: 3）
5. `SqlPane.vue` の表示＋テスト（依存: 4）
6. 実機検証（`scripts/research-sql-exec.mjs` は済。E2E を 1 本）（依存: 5）
7. 空振り検証・文書（backlog・`scripts/README.md`・decisions）（依存: 6）

## リスク / 留意点

- **書き込みは取り消せない。** SQLCA が読めない応答を成功にしない（`insert.ts` と同じ）
- **`reply.rcClass` を見ない**（`Reply` に無い欄。research F7 で実際に踏んだ）。SQLCODE で見る
- **正の SQLCODE は成功**（`7905` など）。捨てると「作られたのに何も言われない」
- **`?` を含む文は断る**（マーカーを埋める道を作っていない）
- 文名は `ASEXEC`（`insert.ts` の `ASUPLOAD` と別）。占有の注意をコメントに
- 判定は**知っているクエリ語だけクエリ**。語境界を見る（`SELECTX` を誤らない）

## テスト方針

- `statement-kind`: spec の境界表をそのままテストにする
- `execute`: 偽の `DbConnection` で **要求の形**（文型 1・文名・マーカーデータ無し）と
  **SQLCODE の扱い**（0 / 正 / 負 / SQLCA 無し）を見る
- `host-sql`: 振り分け（クエリは既存経路・非クエリは `kind: "execute"`）／`?` を断る
- `SqlPane`: 行数・完了・警告の表示／複数文で混在
- 実機: `verify-browser-sql-exec.mjs`（CREATE → INSERT → UPDATE → SELECT で確認 → DROP）

## 空振り検証（mutation）

- `sqlCode < 0` の判定を外す（失敗が成功に見える）
- 正の SQLCODE を失敗にする（警告つき成功が落ちる）
- SQLCA 無しを成功にする
- 文型を 0 に変える（通るはずなので**落ちないのが正しい**＝ミュータントにしない）
- `?` の拒否を外す
- 判定から `WITH` を落とす／語境界を外す
- server の振り分けを常にクエリにする
- 画面が `hasRowCount` を無視する
