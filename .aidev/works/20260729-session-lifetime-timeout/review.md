# レビュー記録

## ラウンド 1（2026-07-29T23:20Z）

差分（25 ファイル / +525 −61）を要件適合・正確性・規約適合・保守性の観点で点検した。
**must は無し。** should 2 件・nit 1 件はこのラウンド内で直した。

### 要件適合

requirement の完了条件 10 件を差分と突き合わせた。全て満たしている。
唯一の逸脱は **MCP 経路で `"never"` を通さない**点で、decisions D1 に理由を残し
warn とドキュメント（README・backlog）に明記した——「黙って曲げない」を守っている。

### 指摘

- [should] `packages/web-ui/src/components/EmulatorPane.vue:701` **既存コメントが浮いた**。
  `noteUserActivity` の JSDoc を差し込んだ結果、`onKeydownCapture` を説明していた既存コメント
  （「次のキー操作でメッセージを消す…capture で拾うこと」）が新しい関数の上に残り、
  どちらの説明か読めなくなっていた。/ 対応: **修正済**（関数の順序を入れ替え、コメントを
  `onKeydownCapture` の直上へ戻した）
- [should] `packages/web-ui/src/stores/systems.ts:66` **型を二重定義していた**。
  `idleTimeout?: "never" | number` と手書きしており、サーバー側の `IdleTimeout` と乖離しうる
  （`Watermark` は共有しているのに揃っていない）。/ 対応: **修正済**——
  `index.ts` から `type IdleTimeout` を公開し、web-ui はそれを import するようにした
- [nit] `packages/web-ui/src/components/ConfigCard.vue:305` **コードの無い説明コメント**。
  「`delete` は要らない」という不在の説明だけが残る。/ 対応: **許容**——
  空振り検証で `delete` が死んだコードだと分かって消した箇所で、
  理由を書かないと次の読み手が「転記漏れ」と見て足し直す。意図の記録として残す価値がある

### 点検して問題が無かった点

- **掃除の粒度**: `startIdleSweep` は 60 秒間隔で、設定の最小値は 1 分。判定は
  `lastActivity < now - limit` なので**早く切ることはなく、遅れる方向**にしかずれない（安全側）
- **`touch()` に所有者検査が無い**: id は WS 接続自身が開いたもので、クライアントから来ない。
  `activity` メッセージも id を運ばない（型に持たせていない）
- **`activity` に readOnly ゲートが無い**: 状態を変えないため不要。閲覧専用セッションでも
  在席は在席
- **監査ログに出さない**: 15〜30 秒間隔で流れるため、出すと本来の記録を量で押し流す。
  利用者の意図を含まないので監査価値も無い
- **`QUIET_TYPES` がマスク処理を飛ばす**: `activity` / `pong` は payload を持たない型なので
  マスク対象が無い。将来値を足せない形にしてある（`ws-messages.ts` に明記）
- **ブラウザ直指定（設定を経ない接続）は永続になる**: 意図どおり。WS 切断と心拍が回収する
- **MCP の host 直指定**は `buildDirectOpts` に `idleTimeoutMs` が無いので 30 分＝従来と同じ
- **`docs/PROTOCOL.md`** は WS メッセージの契約を spec へ委譲しているので更新不要
- **既存テストの修正 9 ファイル**はいずれも実装の欠陥ではない（test-result.md に内訳）。
  うち 7 箇所は `client: {} as WsClient` という嘘の seed で、**Vue がエラーを飲み込んで
  緑のまま unhandled error を出す**状態だった——今回の変更が炙り出した既存の穴
