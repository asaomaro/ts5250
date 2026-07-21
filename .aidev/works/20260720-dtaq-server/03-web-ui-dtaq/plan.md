# 計画: web-ui データ待ち行列（03-web-ui-dtaq）

親 spec.md / design.md を継承。02 が公開した `/api/host/dtaq/*` を UI から使い、
一覧は SQL サービス（`DATA_QUEUE_ENTRIES`）経由（design 判断 3）。scope は親 plan で凍結済み（再分割しない）。

## 実装方針

IFS の `IfsPane.vue` + `ifsApi.ts` を手本にする。**コンポーネントから直接 fetch しない**
（`dtaqApi.ts` に寄せる）。パネルローカルの ref/computed で状態を持つ。

### パネルの構成（デバッグ用の覗き見が主目的・spec 未確定事項の決定どおり）

1. キュー指定（library + name）。IBM i オブジェクト名として検証してから使う
2. 属性表示（`/api/host/dtaq/attributes`）
3. エントリ一覧（**SQL 経由**。`/api/host/sql` に `DATA_QUEUE_ENTRIES` の SELECT を投げる）
4. 送信フォーム（data + encoding utf8/base64/ebcdic、キー付きは key）
5. 受信 / ピーク（encoding 指定、結果表示）
6. クリア / 削除 / 作成（管理操作）

### 一覧の SQL（実機で確定済み）

```sql
SELECT ORDINAL_POSITION,
       CAST(MESSAGE_DATA AS VARCHAR(256)) AS DATA_EBCDIC,
       LENGTH(MESSAGE_DATA_BINARY) AS BYTES,
       HEX(CAST(MESSAGE_DATA_BINARY AS VARCHAR(64) FOR BIT DATA)) AS HEX64,
       MESSAGE_ENQUEUE_TIMESTAMP AS ENQUEUED,
       SENDER_JOB_NAME AS SENDER
FROM TABLE(QSYS2.DATA_QUEUE_ENTRIES(DATA_QUEUE_LIBRARY => '<LIB>', DATA_QUEUE => '<NAME>'))
ORDER BY ORDINAL_POSITION FETCH FIRST 200 ROWS ONLY
```

- **HEX64 が符号化非依存の真値**（`68656C6C6F…` = "hello"）。DATA_EBCDIC は best-effort
  （非 EBCDIC は化ける）。**サーバーの SQL デコーダは CCSID 1208(UTF-8) 列を扱えない**ので
  `MESSAGE_DATA_UTF8` は使わず、EBCDIC 列＋HEX で見せる。UI に「UTF-8/バイナリは受信で確認」と注記。
- **SQL インジェクション対策**: library/name を SQL 文字列に埋めるので、埋める前に
  IBM i オブジェクト名として厳格に検証する（`dtaqApi` 側で弾く）。

## 作業順序と依存関係

1. **T1** `dtaqApi.ts`（`/api/host/dtaq/*` ラッパ + `DtaqRequestError`/`messageFor`/`KNOWN_ERROR_CODES`、
   一覧の SQL 呼び出し、名前検証）（依存: なし）
2. **T2** `DtaqPane.vue`（キュー指定・属性・一覧・送信・受信/ピーク・クリア/削除/作成）（依存: T1）
3. **T3** パネル登録 4 箇所（`paneLabels.ts` / `WorkspaceNode.vue` / `LauncherPane.vue`）（依存: T2）
4. **T4** ユニットテスト（mount + `globalThis.fetch` 差し替え）（依存: T2）
5. **T5** 実ブラウザ E2E（送受信・一覧・属性）＋ lint / vue-tsc / build（依存: T3）

## リスク / 留意点

- **SQL インジェクション**: library/name の検証を厳格に（`/^[A-Z0-9$#@_.]{1,10}$/i` 等）。
- **CCSID の限界**: 一覧の text は EBCDIC 解釈。IFS の CCSID 決定表未対応と同型の限界として UI に明示。
- **一覧と送受信で経路が 2 系統**（SQL=観測、自前=送受信）。UI 上で役割を分けて見せる。
- **無限待ちは UI から作らせない**（サーバーが wait を 0〜60 にクランプ。UI も数値入力を制限）。

## テスト方針

| 観点 | 実機なし | 実機 |
|---|---|---|
| API 層 | 名前検証・エラー文言（messageFor 網羅）・fetch 差し替え | — |
| パネル | mount + fetch 差し替えで送受信・一覧・属性・エラー表示 | — |
| 登録 | パネルが tab prefix で出る | — |
| 通し | — | 実ブラウザで送受信・一覧・属性（naturalWidth 等の実描画確認） |
