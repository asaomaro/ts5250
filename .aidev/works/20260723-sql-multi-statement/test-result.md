# テスト結果: SQL の複数文実行と結果タブ

## 自動テスト

| パッケージ | 結果 |
|---|---|
| core | 844 / 844 合格 |
| server | 530 / 534 合格（**失敗 4 件は `zip-writer` の環境要因**。`unzip` を実行できない） |
| web-ui | 627 / 627 合格 |
| lint / build（`tsc -b` ＋ `vue-tsc` ＋ `vite build`） | 合格 |

追加したもの:

- `core/test/split-statements.test.ts`（17 件）: 素直な 2 文／末尾の `;`／`;;`／空白・コメントだけ／
  **文字列の中の `;`**／`''` エスケープ／**識別子 `"…"` の中の `;`**／`--` と `/* */` の中の `;`／
  文字列の中の `--`／閉じ忘れ／開始位置／改行の保持。`summarizeSql` は先頭コメントを飛ばすこと
- `web-ui/test/sql-multi-statement.test.ts`（8 件）: 書いた順に 1 文ずつ投げること／タブが出て切り替わること／
  **1 文ならタブ帯を出さない**こと／空の区切りでタブを作らないこと／文字列内の `;` で分けないこと／
  **途中失敗で後続を投げず、それまでの結果が残る**こと／単一文では文番号を付けないこと／
  **再実行のたびに開いていた結果セットを全部手放す**こと

既存の `sql-pane.test.ts`（43 件）はそのまま通っている＝単一文の挙動に退行なし。

## 実機検証（PUB400・Web UI を実際に操作）

入力した SQL（**コメントと文字列内の `;` をわざと混ぜた**）:

```sql
SELECT 1 AS ONE, 'A' AS LETTER FROM SYSIBM.SYSDUMMY1;
-- 2 つ目（コメント内の ; は区切りにしない）
SELECT TABLE_NAME, TABLE_SCHEMA FROM QSYS2.SYSTABLES
 WHERE TABLE_SCHEMA = 'QSYS2' ORDER BY TABLE_NAME FETCH FIRST 5 ROWS ONLY;
SELECT 'x;y' AS SEMI FROM SYSIBM.SYSDUMMY1
```

結果:

```
タブ: 1 SELECT 1 AS ONE, 'A' AS LETTE… 1 | 2 SELECT TABLE_NAME, TABLE_SCHE… 5 | 3 SELECT 'x;y' AS SEMI FROM SYS… 1
1 つ目: ONE / LETTER → 1 A
2 つ目: TABLE_NAME / TABLE_SCHEMA → 5 行
3 つ目: SEMI → x;y      ← 文字列の中の ; で分割されていない
エラー表示: (無し)
```

- タブの見出しに**順番・文の要約・行数**が出る
- **コメント内の `;` で分割されない**（2 つ目が 1 文として通っている）
- CSV ボタンの表記が「CSV をダウンロード（表示中の 5 件）」＝**表示中のタブ**を出す
- タブを切り替えると見出しと行が入れ替わる

### 実機で見つけて直したもの

タブの見出しが `-- 2 つ目（コメント内の ; は…` と**先頭コメントだけ**になっていた。
どの文の結果か分からないので、`summarizeSql` が**先頭のコメントを飛ばす**ようにした（テスト追加）。

## 未検証・既知の制約

- **結果を返さない文（INSERT / UPDATE / CREATE 等）は実行できない**（research F2）。
  混ざっていればその文で止まり、何番目かは分かる。DML/DDL の実行は backlog へ
- **5 本以上の SELECT** を含むスクリプトでは、サーバーが古い結果セットから閉じる（1 利用者 4 本まで）。
  古いタブの**続きの読み足しだけ**が期限切れになる（取得済みの行は見える）。**実機では未再現**
- **タブごとの列幅は保持しない**（切り替えると既定に戻る）。列が違うので前の幅を当てる方が害が大きい
- `zip-writer` の 4 件は開発環境で `unzip` を実行できないための失敗で、本変更とは無関係
