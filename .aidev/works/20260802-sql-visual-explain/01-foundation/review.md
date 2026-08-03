# レビュー記録: 01-foundation

## ラウンド 1（2026-08-02）

差分: `db-decode.ts` / `query.ts` / `index.ts` の変更＋`plan-model.ts` と単体テスト 3 本の追加。
観点は requirement・spec・design・AGENTS.md。

### 指摘

- **[must]** `plan-model.ts` `buildQueryPlan` — **`unknownRecordTypes` が `QQQDTN` を持つ記録からしか
  積まれていなかった。** ブロック番号を持たない未知種別（`3018` 等）は `continue` で落ちるため、
  未対応種別として記録されない。
  7.5 だけに出る `3015` が `QQQDTN` を持つ保証はなく、持たなければ**版数差が黙って消える**——
  この欄を設けた目的（research F17「知らない種別を捨てない」）が果たせない。
  **対応: 修正済み。** 未対応種別の収集をブロック判定より前に移し、ノードにできたかに関わらず積むようにした。
  回帰テストを 2 件追加（`QQQDTN: null` の `3015` が積まれること／意図して要約に回す `3019` は数えないこと）。

- **[should]** `packages/server/src/result-set-store.ts` — `close()` が `set.rows.return(undefined)` に
  依存しており、**新設した `OpenedQuery.close()` を使っていない**。
  ジェネレータが 1 度も開始されていなければ `finally` が走らず、F9 と同じ解放漏れになる。
  **現状は潜在的**——`host-sql.ts` は `openQuery` の直後に必ず `resultSets.next()` を呼ぶので、
  本番経路では必ずジェネレータが開始される（コードを追って確認した）。
  ただし **`no-rows` モードを足す `02-capture` で顕在化する**。
  **対応: `02-capture` へ送る**（`packages/server` は 02 の担当層。subtask の境界を越えない）。

- **[nit]** `attributesOf` が `tableOf(r)` を 3 回呼んでいた。**対応: 修正済み**（1 回に束ねた）。

- **[nit]** `buildQueryPlan` の文テキスト抽出「一番長い `QQ1000` を採る」は**ヒューリスティック**。
  `3010`（ホスト変数値）と本文を取り違えないための策で、単体テストでは意図どおり動くが、
  **実機の記録で妥当かは確かめていない**。
  **対応: `02-capture` の実機確認で見る**（外すようなら `QQRID` で本文の在りかを特定する形に変える）。

### 規約の確認

| 観点 | 結果 |
|---|---|
| ピュアロジック層が Node API 非依存（AGENTS.md） | `plan-model.ts` は `node:*` を import していない |
| コメントが why 中心・判断の出所を書く | 実測の出所（research F8/F9/F17・design）を各所に明記 |
| `console.*` 不使用 | 使用なし（lint 通過） |
| 秘密を書かない | 資格情報・文テキストの固定値は含まない |
| 既存の契約を壊さない | `openQuery` は**追加のみ**（`columns`/`rows` は不変）。既存 3,659 テストが緑 |
| 型で分岐を閉じる（周辺スタイル） | `PlanNodeKind` の union と `switch` で表現 |

### 判定

**must 1 件は修正済み**、should 1 件は `02-capture` へ送る（潜在的で、02 の担当層）。
nit 2 件は 1 件修正・1 件は実機確認送り。**この subtask としては通過**。
