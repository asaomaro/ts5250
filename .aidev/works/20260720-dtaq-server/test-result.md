# 統合テスト結果（親 20260720-dtaq-server）

3 subtask（core / server / web-ui）はいずれも単独で review 通過済み。ここでは**結合**
（3 層が繋がって実機まで通しで動くか・契約整合）を確認する。

## 全パッケージのテスト

| パッケージ | テスト |
|---|---|
| core | 739 passed（+ transport `readTimeoutMs` / dtaq datastream / decodeEbcdic 回帰） |
| server | 432 passed（+ dtaq ルート / MCP ツール / base64・KEYED 検証） |
| web-ui | 541 passed（+ dtaqApi / DtaqPane / クリア・削除の回帰） |
| tools | 4 passed |
| **合計** | **1716 passed / 0 failed** |

lint（eslint .）/ tsc -b / web-ui vite build すべてクリーン。`aidev verify` OK。

## 3 層の結線（実機まで通し）

**実ブラウザ E2E（`scripts/verify-browser-dtaq.mjs`）が結合を担保**——
Playwright の実ブラウザ → web-ui バンドル → server（HTTP/SQL）→ core（自前プロトコル）→ 実機 PUB400。
7/7 成功（作成・送信・ピーク・属性・一覧・クリア・削除後 404）。

契約の整合（subtask 横断で確認）:
- **エラーコードの 3 層往復**: core `dtaqFailure`（NOT_FOUND 等）→ server `statusOf`（404/403/409/400/502）
  → web-ui `messageFor`（日本語）。E2E で削除後 `attributes` → 404 NOT_FOUND → 「見つかりません」まで通す。
- **encoding の境界**: core は生バイト、server が utf8/base64/ebcdic を変換、web-ui が符号化を選ぶ。
  E2E で utf8 送受信、単体で base64/ebcdic 往復を固定。
- **無限待ちの歯止め**: core のみ wait=-1 可、server/MCP は 0〜上限にクランプ（HTTP と MCP で同一。02-D5）。
- **一覧は SQL 経由**（design 判断 3）: web-ui → `/api/host/sql`（`DATA_QUEUE_ENTRIES`）。
  self-protocol の送受信とは役割を分離。E2E で hex 一致を確認。

## 独立検証（外部ツールとの突き合わせ）

- 属性: 自前 `attributes()` と QSYS2.DATA_QUEUE_INFO が完全一致（333/KEYED/7/YES）。
- 一覧: SQL `DATA_QUEUE_ENTRIES` の HEX 列（`68656C6C6F…`）＝送信バイトと一致。

## 既知の限界（deliver / backlog へ）

- 一覧の text は EBCDIC 解釈の best-effort（サーバー SQL デコーダが CCSID 1208 非対応。03-D1）。
  UTF-8/バイナリは hex か「受信」で確認。
- キー付きの UI 送受信は基本操作（key＋EQ）。網羅は core/server 側で担保。
- MCP の稼働インスタンス（claude.ai 接続）は再ビルドしないと新ツールを持たない（同一コードを app 経由で検証済み）。
