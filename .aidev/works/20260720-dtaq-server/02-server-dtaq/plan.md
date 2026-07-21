# 計画: server データ待ち行列（02-server-dtaq）

親 spec.md / design.md を継承。01-core-dtaq が公開する `DtaqConnection` を HTTP と MCP から使えるようにする。
scope は親 plan で凍結済み（再分割しない）。

## 実装方針

IFS の `host-ifs.ts` を手本にする（同じ作法: `registerHostXxxRoutes(app, deps)`、zod `.strict()`、
`sourceSchema`、`resolveSource(deps.resolver, source, c.get("user"))`、`try { open } finally { close }`、
`connect?` 注入で偽接続を差せる）。

- **エラー写像は既存 `statusOf` をそのまま使う**——01 の `dtaqFailure` が出す
  NOT_FOUND(404)/ACCESS_DENIED(403)/ALREADY_EXISTS(409)/CONFIG_ERROR(400)/PROTOCOL_ERROR(502) は
  `statusOf` に既に全て入っている（design 判断 4 の確認どおり。追加不要）。
- **encoding 変換は server に置く**（core は生バイト）。`data`/`key` は `utf8`/`base64`/`ebcdic`。
  EBCDIC 変換は `@as400web/core` の codec を使う（システム CCSID、既定 273）。
- **wait には上限**（既定 60 秒、CLI で変更可）。無限待ちは HTTP から許さない（接続張りっぱなし防止）。

## 作業順序と依存関係

1. **T1** `openDtaq` を `host-connect.ts` に足す（依存: なし。他の open* と同型）
2. **T2** `host-dtaq.ts`: 6 ルート（依存: T1）
3. **T3** `app.ts` 登録 + wait 上限の CLI 引数（依存: T2）
4. **T4** MCP ツール `host_dtaq_*`（依存: T1）
5. **T5** ユニットテスト（依存: T2, T4）
6. **T6** 実機 curl 検証 + SQL 突き合わせ（依存: T3）

## リスク / 留意点

- **wait の扱い**: HTTP から来た wait を 0〜上限にクランプ。負値（無限）は弾くか 0 にする。
  受信ルートはソケットを wait+猶予(10 秒) 張るので、上限 60 秒だと最長 70 秒。タイムアウト設計と整合させる。
- **encoding=ebcdic の往復**: 名前・ライブラリは core が EBCDIC 変換する。エントリ本体の ebcdic 変換は
  server の責務。base64 はバイナリ、utf8 はテキスト、ebcdic はシステムキュー向け。
- **senderInfo の返し方**: EBCDIC をデコードした文字列で返す（`dtaqDecodeEbcdic`）。生バイトは載せない。
- **receive の空**: `entry: null`（エラーにしない）。core の undefined を null に写す。

## テスト方針

| 観点 | 実機なし | 実機 |
|---|---|---|
| 入力検証 | zod `.strict()`・wait 範囲・encoding enum を `app.request()` で固定 | — |
| ステータス写像 | 偽接続が投げる As400Error → 404/403/409/400/502 | — |
| encoding 変換 | utf8/base64/ebcdic の送受信を偽接続で往復 | — |
| 6 ルート結線 | — | curl で send/receive/create/clear/delete/attributes。QSYS2 SQL と一致 |
| MCP | `host_dtaq_*` の入出力スキーマ | MCP 経由の送受信 |
