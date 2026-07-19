# テスト結果: 20-server-surfaces

## 自動テスト

| パッケージ | ファイル | 件数 | 結果 |
|---|---|---|---|
| core | 42 | 462 | 緑 |
| server | 26 | 228 | 緑 |
| web-ui | 23 | 289 | 緑 |
| gen-tables | 1 | 4 | 緑 |
| **合計** | **92** | **983** | **緑** |

`npm run lint` / `npm run build` も緑。

## 信頼境界の確認（5 層）

| 層 | 内容 | どこで確認したか |
|---|---|---|
| 1 | 個人セッションスキーマに `printer` を持たせない | `config-migrate.test.ts` / `config-store.test.ts` / `config-routes.test.ts` |
| 2 | サーバー設定への書き込みは admin のみ | `config-routes.test.ts`（一般ユーザーで 403、admin で 201） |
| 3 | display 種別では printer 出力を落とす | `config-routes.test.ts`（保存後に `printer` が無いことを確認） |
| 4 | `autoPdfDir` を保存前に検証する | `config-routes.test.ts`（存在しないディレクトリで 400・未保存） |
| 5 | printer 出力はサーバー設定由来のセッションのみ | `config-resolver.test.ts` |

**5 層すべてに独立した確認がある**（親 spec の受け入れ基準）。

## 実機確認（PUB400）

| 経路 | 指定 | 結果 |
|---|---|---|
| MCP `open_session` | `session: "srv:pub400"` | メニュー到達。ジョブ `736777/USER/WEBEMU01` |
| WebSocket `open` | `session: "srv:pub400"` | メニュー到達。ジョブ `736808/USER/WEBEMU01` |
| ジョブ一覧 | **`system: "srv:pub400.com"` のみ** | 200 / 5 件取得 |
| ジョブ一覧 | `session: "srv:pub400"` | 200 / 3 件取得 |
| 食い違い | `system` と `session` の親が不一致 | **400 `CONFIG_ERROR`** |

装置名 `WEBEMU01` が出ていることから、**セッション設定の装置名が新しい解決経路で正しく適用されている**
ことも同時に確認できた（親 spec B8-1 の deviceName バグの回帰確認を兼ねる）。

要件の中核「SQL・IFS・一覧などはシステムだけを選べば使える」は、
`{ system: "srv:pub400.com" }` だけでジョブ一覧が取れたことで実機で確認済み。

## 未検証（この slice の範囲外・親へ引き継ぐ）

- **ブラウザ経路**。この slice の完了時点で **Web UI は壊れている**（想定内）。
  `stores/connections.ts` が `/api/connections`、`ConnectView.vue` / `HostListPane.vue` が `/api/profiles` を
  叩いており、いずれも登録されていないため 404 になる。**`30-web-ui` で追従する**
- **プリンターセッションの実機確認**。PUB400 の特別権限が `*NONE` で `STRPRTWTR` が使えず、
  ライターが常駐しないため、この環境では検証できない（既存の制約。今回の変更で新たに生じたものではない）
- CI では実機テストが走らない。上記の実機確認はローカルでの手動実行

## 途中で見つけて直した後退

**`host-lists` の 400 が 502 に化けていた。**
新しい `sourceSchema` は `system` と `session` の併記を正当な入力として認め、食い違いは解決時に
`CONFIG_ERROR` になる。旧実装は catch で一律 502 を返していたため、**入力の誤りが「上流障害」として
報告される**状態になっていた。

502 は「上流（IBM i）との通信に失敗した」意味に限るべきなので、`statusOf()` を追加して
`connections` 側と写像を揃えた（`FORBIDDEN`→403 / `SESSION_NOT_FOUND`→404 /
`CONFIG_ERROR`・`CONNECT_FAILED`→400 / それ以外→502）。

これは research F9-3 で「別テーマなので backlog」と判断していた項目だが、
**今回の変更で新たに 400 が 502 に化ける経路を作った**以上、後回しにできないと判断を変えた。
