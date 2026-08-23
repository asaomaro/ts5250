# テスト結果（02-server-dtaq）

subtask 単独で検証できる範囲（入力検証・ステータス写像・encoding 変換・結線）を検証した。
web-ui との結合は親の統合 test に委ねる。

## 自動テスト（実機なし）

- **server 全体: 423 passed / 37 files**（新規 `host-dtaq-routes.test.ts` 23 を含む）。
- `test/host-dtaq-routes.test.ts`（23）— `Hono` + `app.request()` + 偽 `connect` でハンドラ本体を通す:
  - send: utf8/base64 のバイト変換、キー付き、名前 10 文字超で 400
  - receive: 空→`entry:null`、data を要求 encoding で返す、senderInfo デコード、
    **encoding=ebcdic の判別テスト**（EBCDIC273 の 0xC1 0xC2 → "AB"。utf8 経路と区別できる）、
    wait クランプ、負の wait を 400、キー検索
  - create: KEYED で keyLength 欠落 400 / 非 KEYED で keyLength あり 400 / maxLen 上限 / FIFO 200
  - attributes/clear/delete
  - **エラー写像**: NOT_FOUND→404 / ACCESS_DENIED→403 / ALREADY_EXISTS→409 / CONFIG_ERROR→400 /
    PROTOCOL_ERROR→502、失敗しても接続を閉じる
- `test/host-server-tools.test.ts` に DTAQ の 6 MCP ツールを追加固定（登録・入力スキーマに
  user/password/host が無い・資格情報無しで CONFIG_ERROR）。
- lint / build（tsc -b, 全パッケージ）クリーン。

## 実機検証（PUB400 / TESTLIB、HTTP ルートを app.request で直接叩く）

`ServerConfigStore` に pub400 システム（`signon.passwordEnv`）を積み、実 `openDtaq` で 6 ルートを往復:

| ルート | 結果 |
|---|---|
| create FIFO | `[200] {ok:true}` |
| send utf8 | `[200] {ok:true}` |
| send base64 | `[200] {ok:true}` |
| attributes | `[200] {maxEntryLength:200, FIFO, keyLength:0, saveSender:true}` |
| receive utf8 | `hello-e2e` + senderInfo `QZHQSSRV QUSER … USER` ✓ |
| **receive base64** | `AQID`（= [1,2,3] の base64）✓ バイナリ往復が通る |
| receive empty | `{entry:null}` ✓ |
| clear → receive | クリア後 `{entry:null}` ✓ |
| delete | `[200] {ok:true}` |
| **attributes on deleted** | **`[404] {error:"… CPF9801", code:"NOT_FOUND"}`** ✓ |

最後の 1 行が重要: **エラー応答 0x8002 の CPF 抽出→NOT_FOUND→404 が実バイトで通った**
（core の decisions D1 で「未採取」としていた宿題が解消。decisions D1）。テスト後のキューは削除済み。

## 未検証（親の統合 test / 03 に引き継ぎ）

- web-ui からの結線（03）。一覧は SQL 経由（design 判断 3）なので DTAQ ルートは送受信・管理のみ。
- 稼働中の MCP サーバー（claude.ai 接続）は再ビルドしないと新ツールを持たない。MCP の実機叩きは
  同一コードを app 経由で往復させて代替済み（同じハンドラ・同じ core 経路）。
