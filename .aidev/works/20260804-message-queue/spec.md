# 仕様: メッセージ待ち行列

## 概要

一覧・送信・応答・削除を、MCP / REST / 画面から行えるようにする。
**照会メッセージへの応答**が主目的——応答しないとジョブが止まったままになる。

## 設計方針

### D1: 既存の 3 層に載せる（新しい配管を作らない）

| 操作 | 層 |
|---|---|
| 一覧 | SQL（`QSYS2.MESSAGE_QUEUE_INFO`） |
| 送信・応答・全消し | CL（`SNDMSG` / `SNDRPY` / `CLRMSGQ`） |
| キー指定の削除 | **プログラム呼び出し**（`QSYS/QMHRMVM`。`RMVMSG` は CL 内でしか使えない） |

### D2: **CL へ渡す値を検査する**（この作業で一番危ういところ）

送信本文も応答文も**利用者の入力がそのまま CL コマンド文字列に入る**。

- **名前（待ち行列・ライブラリー・利用者）は書式で縛る**——`A-Z0-9#$@_` の 10 文字以内。
  ここを緩めると `MSGQ(X) DLTLIB(...)` のような**別のコマンドを差し込まれる**
- **本文の `'` は `''` にする**（CL の文字列の作法）。閉じ引用符を早じまいさせない
- **改行・制御文字は拒否**（コマンドが途中で切れる）

### D3: キーは 16 進文字列

`HEX(MESSAGE_KEY)` の出力（`00000220` のような 8 桁）をそのまま使う。
`SNDRPY` は `X'…'` の形で受け、`QMHRMVM` はバイト列で受けるので、**こちらで変換する**。

同じ本文のメッセージが複数あっても、キーなら取り違えない。

### D4: 消すのは明示的な操作

一覧を読んだだけでは消えない（`RCVMSG` のような「読んだら消える」動作にしない）。
**間違って消したら戻せない**ので、消す口は分ける。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `server/src/host-message.ts` | **新規**——REST 4 本 |
| `server/src/host-server-tools.ts` | MCP ツール 4 つ |
| `web-ui/.../MessagePane.vue` | **新規** |
| `web-ui` の登録 | `msg:` 接頭辞・ラベル・機能一覧 |

## インターフェース / データ構造

```ts
// POST /api/host/messages          一覧
{ source, queue, library?, max?, onlyInquiry? }
→ { messages: [{ key, id, type, subtype, severity, text, secondLevel?,
                 timestamp, fromUser, fromJob, fromProgram }] }

// POST /api/host/messages/send     送信
{ source, text, toUser? , toQueue?, toLibrary?, inquiry?, replyQueue?, replyLibrary? }
→ { success, messages }

// POST /api/host/messages/reply    応答
{ source, queue, library?, key, reply }
→ { success, messages }

// POST /api/host/messages/remove   削除
{ source, queue, library?, key? }   // key 省略で全消し
→ { success, messages }
```

MCP は `host_list_messages` / `host_send_message` / `host_reply_message` /
`host_remove_messages`。

## 振る舞いの詳細

| 状況 | 結果 |
|---|---|
| `library` 省略 | `*LIBL` |
| `onlyInquiry` | `MESSAGE_TYPE = 'INQUIRY'` だけ返す（**応答すべきものだけ**） |
| 照会を送る | 待ち行列に 2 件入る（`SENDER` と `INQUIRY`）。**これは IBM i の仕様** |
| 応答が成功 | その `INQUIRY` が `REPLY` に変わる |
| 削除でキー省略 | **全消し**（`CLRMSGQ`） |
| 名前が書式に合わない | `CONFIG_ERROR`（**コマンドを組み立てない**） |
| 本文に改行・制御文字 | `CONFIG_ERROR` |

## ドメイン固有の考慮

- **`SELECT *` は使えない**（`MESSAGE_KEY` が BINARY で DB 層が未対応）。列を明示する
- **本文は VARGRAPHIC** なので `CAST(… AS VARCHAR(n) CCSID …)` を通す。CCSID は接続のもの
- **`QSYSOPR` は共有**。検証は専用の待ち行列で行う

## エラー処理 / 異常系

- CL / API の失敗は**ホストのメッセージをそのまま返す**（既存の形）
- 名前・本文の検査は `CONFIG_ERROR`（利用者が直せる）
- 待ち行列が無い → ホストのメッセージ（`CPF2403` 等）がそのまま出る

## 受け入れ基準との対応

| 完了条件 | どう満たすか |
|---|---|
| 一覧できる | SQL。キー・種別・重大度・本文・送信元 |
| **照会に応答できる** | `SNDRPY` ＋ キー。`INQUIRY` → `REPLY` を実機で見る |
| 送れる | `SNDMSG`（通知・照会） |
| 削除できる | `QMHRMVM`（キー）／`CLRMSGQ`（全部） |
| MCP / REST | 4 本ずつ |
| 画面 | `msg:queue` ペイン |
| 実機で往復 | 専用の待ち行列で通す |
