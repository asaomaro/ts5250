# タスク: ホストサーバー経由の SQL 実行

## codec（純 DBCS 対応）

- [x] T1: `codec/table-types.ts` に `DbcsPart` / `PureDbcsTable` を追加（既存 `StatefulTable.dbcs` の内側を切り出す。既存の型は壊さない）
- [x] T2: `codec/pure-dbcs.ts` — `PureDbcsCodec`（2 バイト固定・SO/SI なし）。単体テスト付き（依存: T1）
- [x] T3: CCSID 16684（`ibm1399.dbcs` を再利用）と CCSID 300（16684 + 15 箇所の差分）を公開。**差分の単体テスト付き**（依存: T2）

## 型変換（純粋関数）

- [x] T4: `db/db-types.ts` — DB2 型コード定義、NULL 可（最下位ビット）判定、型名。単体テスト付き
- [x] T5: `db/db-decimal.ts` — パック / ゾーン 10 進数 → 文字列。**符号位置の違いを両方テスト**（依存: なし）
- [x] T7: `db/db-decode.ts` — 列メタ＋行バッファ → `DbValue`。固定バイト列の単体テスト付き（依存: T3,T4,T5）

## プロトコル

- [x] T6: `db/db-datastream.ts` — 40 バイト template の解析、`rcClass` のエラー判定、要求組み立て。単体テスト付き
- [x] T8: `db/db-connection.ts` — signon でパスワードレベル取得 → database 接続（`0xE004`）→ RPB 作成（依存: T6）
- [x] T9: `db/query.ts` — prepare→describe→open→fetch。**NULL 指標の形式を実機で確認して実装**（依存: T7,T8）

## 公開と検証

- [x] T10: `index.ts` に公開 API と `SqlError` を追加、`errors.ts` に `SQL_ERROR` を追加（依存: T9）
- [x] T11: 実機検証 — `TESTLIB.SQLTYPES` の全型を突き合わせ、SQL エラー 2 ケース、TLS/平文の双方（依存: T10）
