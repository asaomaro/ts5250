# タスク: 02-capture

- [x] T1: `plan-model.ts` に**対象文の記録を選ぶ純関数**を足す
      （`QQ1000` 一致 → 計画記録が最多の `QQUCNT`、の 2 段）
- [x] T2: `plan-capture.ts` — `STRDBMON` → 文（`run` / `no-rows`）→ `ENDDBMON` → 読み出し → `DROP`。
      **後始末は `finally` で必ず通す**。開始前の残骸掃除つき（依存: T1）
- [x] T3: `plan-cache.ts` — `DUMP_PLAN_CACHE_TOPN` による一覧と単一計画。
      **`-443/38501` を権限不足として判定**し、他の SQLCODE は原因をそのまま返す（依存: T1）
- [x] T4: `host-plan.ts` — REST 3 本（explain / 一覧 / 一覧からの計画）＋**explain 専用プールキー**
      （依存: T2, T3）
- [x] T5: MCP ツール 2 本（`host_sql_explain` / `host_plan_list`）。
      ノード 50 件上限・`attributes` は `detail:true` のときだけ（依存: T2, T3）
- [x] T6: `result-set-store.ts` を `OpenedQuery.close()` 経由にする（01 レビューの should）
- [x] T7: 単体テスト（依存: T1, T2, T3, T6）
      - 後始末の不変条件（順序・回数・異常時）
      - `STRDBMON` 失敗時に文を実行しない
      - 権限拒否の判定（`38501` だけを権限と言う）
      - 文の選別（一致・代替）
      - `result-set-store` が未反復でも解放する
- [x] T8: `npm run build` / `npm run lint` / `npm test` を通す（依存: T4, T5, T7）
