# テスト結果: 結果を返さない SQL 文を実行する

## 実機実測（この作業の要）

| スクリプト | 確かめたこと | 結果 |
|---|---|---|
| `research-sql-exec.mjs` | `prepareAndDescribe` → `execute` が DML / DDL を通すか | **通る**（13 ケース。`executeImmediate` は不要と判明） |
| `verify-browser-sql-exec.mjs` | SQL 画面から実際にホストの表が変わるか | **13/13**（実機・`TESTLIB/SQLEXECB`） |

E2E の内訳（画面のスクリーンショットは `/tmp/as400-verify-sql-exec/shots`）:

- **DDL**: `CREATE TABLE TESTLIB.SQLEXECB` → 「実行しました。（警告 SQLCODE=7905 SQLSTATE=01567）」。
  **実ライブラリーへの CREATE は警告つき成功で返る**（research F6 の予測どおり。
  警告を捨てていたら「作られたのに何も言われない」になっていた）
- **行数の意味が無い文に「0 行に影響しました」と出さない**
- **DML**: INSERT → 「1 行に影響しました。」/ UPDATE（2 行）→「2 行に影響しました。」/
  DELETE → 「1 行に影響しました。」
- **書き込みが実際に効いている**: 続けて SELECT すると `ID=2 / S=z` だけが残っている
  （ID 1 が消え、S が更新されている）
- **失敗が理由付き**: `DELETE FROM TESTLIB.NOSUCHTBL` → 「文を準備できませんでした:
  SQLCODE=-204 SQLSTATE=42704」（赤字のエラー表示）
- **`?` 付きは実行前に断る**（要求を 1 つも送らない）
- **`;` 区切りの混在**: 1 番目のタブが「1 行に影響しました。」、2 番目が表
- **DROP できる**（後片付け）

応答時間は 29〜61ms。**書き込みに成功した接続をプールへ返している**ので、
2 文目以降は接続の張り直し（4〜6 秒）が起きていない。

## 自動テスト

| 対象 | 結果 |
|---|---|
| core / server / ebcdic / scs | **1865 passed**（4 failed は既知の環境不足＝`unzip` 無し。`main` でも同じ） |
| web-ui（パッケージ dir から実行） | **1235 passed** / 106 ファイル。unhandled error 0 |
| `tsc -b` / `vue-tsc` ＋ `vite build` | 通る |
| lint（新規スクリプト 2 本を含む） | error 0 |

### 新規テスト

| ファイル | 件数 | 見ているもの |
|---|---|---|
| `core/test/sql-statement-kind.test.ts` | 35 | spec の境界表（クエリ 10 / 非クエリ 18 / 語境界 / 空・コメントのみ / マーカーの検出とリテラル・コメントの除外） |
| `core/test/sql-execute.test.ts` | 18 | 要求の形（2 往復・**マーカーを載せない**・文型 1・文名が `insert.ts` と別・CCSID 13488・SQLCA ビット・占有と解放）／SQLCODE の扱い（0 / 正 / 負 / SQLCA 無し）／**DDL と 0 行 DML の区別**／`?` の拒否 |
| `server/test/host-sql-execute.test.ts` | 14 | 振り分け（**文名で経路を見分ける**）／`kind: "execute"` の応答／警告／プールの扱い（成功は返す・SQL 誤りは返す・不明は捨てる）／資格情報が無い設定は 400 |
| `web-ui/test/sql-pane-execute.test.ts` | 10 | 「N 行に影響しました」/「実行しました」/ 警告の併記 / 「該当する行はありません」を出さない / CSV を出さない / 混在タブの切り替え / DDL タブは「済」 |

## 空振り検証（mutation）: 18/18

`SQLCODE < 0` の判定を外す / 正の SQLCODE を失敗にする / SQLCA 無しを成功にする /
警告を捨てる / **`hasRowCount` を件数から決める** / `?` の拒否を外す /
prepare 失敗でも execute へ進む / 判定から `WITH` を落とす / 語境界を見ない /
先頭コメントを取り除かない / リテラル内の `?` も数える / 振り分けを常にクエリにする /
`kind` を付けない / **資格情報の解決を try の外へ戻す** / 失敗した接続もプールへ戻す /
画面が `hasRowCount` を無視する / 画面が警告を出さない /
画面が「該当する行はありません」も出す。

**空振りは 0。** ただしミュータント 1 本は当初「等価変形」を書いてしまい、
落ちないのが正しいものになっていた（それでは歯止めを確かめられない）ので、
**実際に踏んだ欠陥そのもの**（解決を try の外へ出す）に書き換えて確認し直した。

## 実装中に見つけて直したこと

1. **`hasRowCount` を SQLCA の件数から決めていた**（decisions D1）。
   research F3 の実測（DDL も `updateCount: 0`）と突き合わせて気づいた——
   そのままなら `CREATE TABLE` に「0 行に影響しました」と出ていた。
2. **資格情報を持たない設定で 500 になっていた**。接続先の解決を `try` の外に置いていたため、
   `hostAuthFrom` の `CONFIG_ERROR` が捕まらず「ユーザーとパスワードが未登録」を伝えられなかった。
   **既存の `host-sql.test.ts` が検出した**（新機能が既存の規律を壊した形）。
3. **コメント内の `?` で正しい文を断っていた**（decisions D2）。
4. **腐った説明の是正**（decisions D5）: `host-sql.ts` 冒頭の「構造的に読み取り専用」、
   それを参照していた `app.ts` / `host-upload.ts`、既存テストの節名、
   `SqlPane.vue` の docstring・画面の案内文（「SELECT のみ実行できます」）。

## 未検証の穴

- `packages/server/test/zip-writer.test.ts` の 4 件は**環境に `unzip` が無い**ため失敗する
  （`main` でも同じ。この変更とは無関係）
- MCP の `host_sql` は SELECT 専用のまま（decisions D4。意図的に広げていない）
- マーカー（`?`）付きの非クエリ文は**スコープ外**（実行前に断る。backlog に残した）
