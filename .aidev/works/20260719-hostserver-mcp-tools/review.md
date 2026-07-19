# レビュー記録

## ラウンド 1（2026-07-19T16:55Z）

自己レビュー（主エージェントが差分を直読）。前段の指摘の再発チェック——
ピュア層への Node グローバル混入**なし**（変更は `packages/server` のみで core は無改変）、
`Object.assign` による型外し**なし**、参照コメントあり。

- [should] `host_sql` の `maxRows` が**応答の切り詰めにしか効いていない**。
  `query()` は結果セットを全件取得してから返すため、`SELECT * FROM 大きな表` を投げると
  `maxRows` に関係なくホストから全行を引いてメモリに載せる。`truncated: true` を返すことで
  「上限で保護している」と読めてしまうのが特に悪い（**実態より安全に見える**）。
  / 対応: 修正済（説明文に「maxRows は応答に載せる行数の上限であって取得する行数の上限ではない。
  大きな表では FETCH FIRST を付けること」と明記し、コードにも意図コメントを置いた）。
  **`stream` で早期打ち切りする案は採らなかった**——カーソルを途中で閉じる経路が未検証で、
  「整理に見える変更が退行だった」（`20260718-hostserver-ifs` の教訓）を繰り返しかねないため。
  取得量の制御自体は backlog に残す

- [should] 移設に伴い `/api/host/list/*` のエラーメッセージが変わった。
  旧「…ため**一覧を取得できません**」→ 新「…ため**ホストサーバーに接続できません**」。
  共有ヘルパにした以上、一覧固有の文言は不正確なので変更自体は妥当だが、
  **利用者から見える文言の変更**であり黙って通すべきではない。
  / 対応: 許容（既存テストは `/ユーザーとパスワード/` で通り、意味は保たれている。
  新しい文言のほうが SQL・IFS・スプールを含む実態に合う）

- [nit] `compact()` が `host-lists.ts` と `host-server-tools.ts` に**重複**している
  （`exactOptionalPropertyTypes` 対策の 6 行）。
  / 対応: 許容（依存の向きを増やしてまで共有する量ではない。3 箇所目が出たら切り出す）

- [nit] `host_call_program` の `outputs` が「要求順で返る」前提に依存している。
  この前提は `20260718-hostserver-command` の review で core 側にコメント済みだが、
  MCP の利用者からは見えない。
  / 対応: 修正済（ツールの description に前提を明記した）

- [nit] `withAudit(...).catch(errorResult)` という形にしたため、監査ログは
  `isError` 応答としてではなく**例外**として記録される（`audit.ts` の catch 分岐）。
  結果の `result: "error"` と `code` は同じく残るので実害は無い。
  / 対応: 許容（既存 5250 ツールは try/catch を内側に書く形で、そちらは isError 分岐を通る。
  記録される内容は一致するため統一の実益が薄い）

- [nit] `host_get_spool` の `outputSchema` が `lines` / `pages` の両方 optional。
  `format` による排他が型で表現できていない。
  / 対応: 許容（MCP の outputSchema は ZodRawShape で union を取れない）

must 0 件・should 2 件・nit 4 件。should は 1 件修正・1 件許容（理由を記録）。

## 実機検証で追加確認した点（review 中に判明）

`maxRows` の指摘を確かめる過程で、**ブロッキング係数（既定 100 行）を跨ぐ取得**を実測した。
backlog の未検証項目に部分的な答えが出た:

| 検証 | 結果 |
|---|---|
| 250 行 / maxRows 既定 200 | `rowCount=200` `truncated=true`（100 行の境界を 3 回跨いで正しく取得） |
| 250 行 / maxRows 1000 | `rowCount=250` `truncated=false` |
| 5 行 / maxRows 3 | `rowCount=3` `truncated=true` |

**`query` の内部 fetch ループは 100 行境界を跨いで正しく回る**ことが確認できた。
ただし backlog 項目が指しているのは `stream`（`AsyncGenerator`）のほうで、
**そちらは依然として未検証**である。混同しないこと。
