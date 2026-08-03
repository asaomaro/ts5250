# タスク: 01-foundation

- [x] T1: **F8** `db-decode.ts` の `decodeText` を `isBinaryCcsid` 経由にし、CCSID 65535 の
      CHAR / VARCHAR / LONGVARCHAR を **16 進の大文字文字列**で返す（`RangeError` を投げない）
- [x] T2: **F9** `openQuery` に**冪等な `close()`** を足し、1 行も読まずに閉じても
      カーソルと接続が解放されるようにする（`iterate()` の `finally` も同じ `close()` を通す）
- [x] T3: `plan-model.ts` に `QueryPlan` / `PlanBlock` / `PlanNode` / `PlanNodeKind` /
      `IndexAdvice` / `PlanSummary` / `PlanAttribute` を定義して**型を凍結**する（依存: なし）
- [x] T4: モニター記録 → `QueryPlan` の畳み込みを**純関数**で実装する（依存: T3）
      - `QQQDTN` でクエリブロックに分ける
      - `QQQDTL=0` の `3019` は**ノードにせず**要約に回す
      - 種別の写像は **`3000`=`table-access` / `3001`=`access-method` / `3020`=`advice` のみ命名**
      - それ以外は `other`＋値の入った列を `attributes` に載せ、`unknownRecordTypes` に積む
- [x] T5: `3020` から `IndexAdvice` を組み立て、`CREATE INDEX` 文を生成する（依存: T3）
- [x] T6: 採取時に読み出す**列の明示リスト**（`SELECT *` を使わないため）と、
      記録 1 行を表す型を定義する（依存: T3）
- [x] T7: 単体テストを書く（依存: T1, T2, T4, T5, T6）
      - F8 の回帰（65535 が 16 進／既存 CCSID は従来どおり）
      - F9 の回帰（未反復で閉じても解放・冪等）
      - 畳み込み（ブロック分け・写像・未知種別・要約・索引助言）
- [x] T8: `hostserver/src/index.ts` から必要な型・関数を公開する（依存: T3, T4, T5, T6）
- [x] T9: `npm run build` / `npm run lint` / `npm test -w @ts5250/hostserver` を通す（依存: T8）
