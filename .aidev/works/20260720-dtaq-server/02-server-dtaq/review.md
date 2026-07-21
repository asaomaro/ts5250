# レビュー（02-server-dtaq）

subtask 単独のレビュー。HTTP ルート（host-dtaq.ts）・MCP ツール・app/main の配線・host-connect を、
独立レビュー（別エージェント）＋自己レビューで点検した。

## ラウンド 1（独立レビュー + 自己レビュー）

### must: なし

### should（3 件・**このラウンドで修正・再検証済み**）

- **S1 MCP の receive が operator の待機上限を無視**（`host-server-tools.ts`）。HTTP は
  `deps.receiveMaxWaitSec`（`--dtaq-max-wait` で可変）でクランプするのに、MCP は定数 60 で
  クランプしていた。`--dtaq-max-wait 5` で締めても /mcp だけ 60 秒まで待てる。
  **修正**: `ToolDeps` に `dtaqReceiveMaxWaitSec?` を足し、HTTP（クランプ済み値）と stdio（buildDeps）
  から配線。MCP も同じ上限を尊重（decisions D5）。無限待ちの禁止は元から両サーフェスで成立。
- **S2 MCP create が KEYED/keyLength 整合を弾かない**（`host-server-tools.ts`）。HTTP は 400 で弾く
  2 つの不整合（KEYED で keyLength 欠落／非 KEYED で keyLength 付与）を MCP は素通ししていた。
  **修正**: MCP create に同じ検査を追加（接続前に CONFIG_ERROR）。テストで固定（decisions D6）。
- **S3 base64 の黙った切り詰め**（`host-dtaq.ts`）。`Buffer.from(..,"base64")` は不正文字を無視し、
  意図と違うバイト列を積む（バイナリ送信の footgun）。**修正**: `toBytes` で base64 を検査し
  不正なら CONFIG_ERROR。変換を `withDtaq` 内に移して `statusOf` が 400 に写せるようにした。
  実機 e2e で `!!!!` → 400 を確認（decisions D7）。

### 独立レビューで確認済み・指摘なし

- **接続リーク無し**: HTTP `withDtaq` は try 内で open・finally で `conn?.close()`（成功/例外の両方で閉じる。
  connect/resolveSource が投げれば conn は undefined で finally は no-op）。MCP は open 直後 try、finally で close、
  open が投げれば `.catch(errorResult)`。例外の窓でソケットが漏れない。
- **wait は負値・無限にならない**: 両スキーマ `.int().min(0)`、両方 `Math.min` でクランプ。上限の下限は 1（parseLimit / limit）。
- **zod は全ルート `.strict()`**、name max(10) / maxEntryLength max(64512) / keyLength max(256) / encoding enum が HTTP と MCP で一致。
- **受信の空 → `entry:null`**、senderInfo は `dtaqDecodeEbcdic`、bytes は `entry.data.length`。両サーフェスで正しい。
- **注入リスク無し**: name/library は固定長 EBCDIC フィールドに書く（CL 文字列に混ぜない）。

## 結果

- must 0 / should 3（いずれも修正・再検証済み）/ nit 0
- server 432 passed、lint / build クリーン
- 実機 e2e（6 ルート往復・エラー 404・base64 往復と不正 400）を再確認
- 3 修正はいずれも「HTTP と MCP の挙動を揃える／footgun を塞ぐ」方向で、既存挙動は壊していない
