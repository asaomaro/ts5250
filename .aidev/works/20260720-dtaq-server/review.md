# 統合レビュー（親 20260720-dtaq-server）

3 subtask はいずれも単独で review 通過済み（各々に独立エージェントの adversarial review を実施）。
ここでは**結合起因**の欠陥と subtask 横断の一貫性を見る。

## 各 subtask の review 履歴

- **01-core**: must 0 / should 2（decodeEbcdic の '@' 取りこぼし・commonReplyRc 長さガード）→ 修正済み
- **02-server**: must 0 / should 3（MCP の wait 上限尊重・MCP create の整合検査・base64 の黙った切り詰め）→ 修正済み
- **03-web-ui**: must 0 / should 2 + low 1（listEntries の json 握り・onDelete の畳み・onClear の message）→ 修正済み

いずれも独立レビューで「SQL インジェクション不可」「トランスポート後方互換」「接続リーク無し」を確認済み。

## 結合の観点で確かめたこと

### エラーコードの 3 層往復（契約が閉じているか）

| core `dtaqFailure` | server `statusOf` | web-ui `messageFor` |
|---|---|---|
| NOT_FOUND | 404 | 「見つかりません」 |
| ACCESS_DENIED | 403 | 「権限がありません」 |
| ALREADY_EXISTS | 409 | 「既にあります」 |
| CONFIG_ERROR | 400 | 入力の誤り（error 本文） |
| PROTOCOL_ERROR | 502（default） | default（サーバー文言） |

**core が投げる全コードを server が写像し、web-ui が日本語化する**（PROTOCOL_ERROR は 502＋サーバー文言で妥当）。
E2E で削除後 `attributes` → 404 → 「見つかりません」まで通しで確認。IFS の 3 層往復と同じ構造。

### 契約の整合（subtask 境界）

- **encoding**: core=生バイト / server=utf8・base64・ebcdic 変換（`toBytes`/`fromBytes`を HTTP と MCP で共有）/
  web-ui=符号化を選ぶ。base64 の厳格検査は server に 1 箇所（両サーフェス共通）。
- **wait の歯止め**: core だけ無限待ち可、server(HTTP)・MCP は同じ上限でクランプ（02-D5 で両サーフェス統一）。
  web-ui は数値入力を 0〜60 に制限し、負値は `Math.max(0,…)`。多重の歯止めが一貫。
- **一覧の経路**: web-ui → `/api/host/sql`（既存ルート）で `DATA_QUEUE_ENTRIES`。DTAQ 専用ルートは
  送受信・管理のみ（design 判断 3）。**観測（SQL）と操作（自前プロトコル）の役割分離**が 3 層で一貫。
- **型の共有**: `DtaqEntry`/`DtaqAttributes`/`DtaqSearchOrder` は core の `dtaq-types.ts` を
  `@as400web/core/browser` 経由で web-ui が参照（実行時依存を増やさない）。

### 実機まで通し

実ブラウザ E2E 7/7（browser → web-ui → server → core → PUB400）。属性は QSYS2.DATA_QUEUE_INFO と、
一覧の hex は送信バイトと独立に一致を確認。

## 未実装 / 限界（deliver で明示・backlog 候補）

- 一覧 text の CCSID 決定（サーバー SQL デコーダが 1208 非対応）。UTF-8/バイナリは hex か受信で確認（03-D1）。
- キー付きの UI 送受信は基本操作のみ（網羅は core/server）。
- エラー応答 CPF の位置は実機で確認済み（走査で拾えた・02-D1）。

## 結果

- 結合起因の must/should: なし（各 subtask で解消済み）
- 全 1716 テスト・lint・tsc/vite build・`aidev verify` クリーン、E2E 7/7
- 差分は大きく 3 モジュール横断・処理フローも非自明 → **walkthrough を挟む**
