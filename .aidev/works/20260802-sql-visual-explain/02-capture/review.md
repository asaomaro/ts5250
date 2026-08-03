# レビュー記録: 02-capture

## ラウンド 1（2026-08-02）

差分: `plan-capture.ts` / `plan-cache.ts` / `host-plan.ts` の追加、`host-server-tools.ts` に MCP 2 本、
`result-set-store.ts` / `host-sql.ts` / `app.ts` の変更、単体テスト 3 本。

### 指摘

- **[must]** `host-server-tools.ts` `host_sql_explain` — **既定が `mode: "run"` だった。**
  MCP は AI が呼ぶ入口で、「この DELETE を explain して」という依頼が**そのまま削除を実行する**。
  `explain` という語から利用者（と LLM）が期待するのは「調べるだけ」で、取り消せない操作が
  既定で走るのは危険。
  **対応: 修正済み。既定を `no-rows` にした。** 更新系は `capturePlan` に拒否されるので、
  実行するには呼ぶ側が `mode=run` を明示することになる。説明文にもその旨を書いた。
  （`no-rows` でも SELECT はホストで実行される。そこは説明文で正直に書いている。）

- **[should]** `host-plan.ts` `withExplainConn` — **失敗時に `SqlError` 以外をすべて捨てていた。**
  `capturePlan` は `ENDDBMON` / `DROP` を `finally` で通すので、
  「計画記録が採れなかった（`NOT_FOUND`）」「`no-rows` に非クエリを渡した（`CONFIG_ERROR`）」は
  **後始末が済んだうえでの失敗＝接続は健全**。捨てると次回の接続確立で 4〜7 秒（PUB400 実測）待たされる。
  **対応: 修正済み。** `isConnectionHealthy` を切り出し、`SqlError` / `NOT_FOUND` / `CONFIG_ERROR` は
  プールへ返すようにした。あわせて `capturePlan` の「記録なし」を `PROTOCOL_ERROR` から
  **`NOT_FOUND`** に変えた（呼び出し側が「壊れた」系と区別できるようにするため）。

- **[nit]** 実機疎通で `unknownRecordTypes` に `1000` が毎回入っていた。
  `1000` は文テキストの在りかとして**こちらが意図して使っている**記録なので、
  未対応に数えると「未対応の記録種別があります」が毎回出て、**版数差（`3015`）という
  本来の信号が埋もれる**。**対応: 修正済み**（`3019` と同じく「意図して消費した記録」に分類）。

- **[nit]** `plan-cache.ts` の `dumpTopN` が呼び出しごとに再ダンプする。
  一覧 → 選択で 2 回ダンプすることになるが、**状態を持たない方を採った**
  （キャッシュは変わりうるので、保持しても正しさは上がらない）。
  id が消えていた場合は理由付きで返す実装になっており、テストで固定済み。**このままとする。**

### 01 レビューからの引き継ぎ

| 指摘 | 対応 |
|---|---|
| [should] `result-set-store` が `OpenedQuery.close()` を使っていない | **対応済み**。`closeCursor` を預かる経路を足し、`host-sql.ts` から渡した。回帰テスト 3 件 |
| [nit] 文テキスト抽出が実機で妥当か | **実機で確認**。`run` / `no-rows` とも正しい文が採れた（`test-result.md`） |

### 規約の確認

| 観点 | 結果 |
|---|---|
| ピュアロジック層が Node API 非依存 | `plan-model.ts` は純関数のまま。I/O は `plan-capture.ts` に隔離 |
| コメントが why 中心・出所を書く | research F7/F9/F13/F14/F15/F16 と design 判断を各所に明記 |
| 既存の認可方針を踏襲 | 索引作成は専用入口を作らず `/api/host/sql` へ（新しい権限を増やさない） |
| 監査に載せる | MCP 2 本とも `withAudit` |
| MCP のトークン量 | ノード 50 件上限＋`truncated`、`attributes` は `detail:true` のときだけ |
| 秘密を書かない | 文テキストをログに出していない |
| 既存の非退行 | 3,691 件緑。`/api/host/sql` のコードパスは `closeCursor` を渡す 1 行のみ追加 |

### 判定

**must 1 件・should 1 件・nit 2 件のうち 3 件を修正**、1 件（再ダンプ）は理由を添えて現状維持。
**この subtask としては通過**。
