# 調査: プリンター常駐化の現状

コードは 2026-08-01 時点の `main`。実機は使っていない（この工程は読解）。

## F1. 常駐を妨げているのは 3 か所だけ

| 箇所 | 何が起きるか |
|---|---|
| `ws-handler.ts:513`（`dispose`） | WS が閉じると `sessions.close(this.sessionId)` を呼ぶ。**タブを閉じたら切れる** |
| `session-manager.ts:845-850`（`sweepIdle`） | `printers` も掃除対象。既定は `"never"` だが `--idle-timeout` で有限にできる |
| `session-manager.ts:369`（`size`） | `sessions.size + printers.size`。**上限 8 を表示と取り合う** |

**プリンターの機構そのものは既に常駐向き**——`PrinterEntry` は
`reports`（受信済み・順）/ `delivered`（次に返す位置）/ `outputWarnings`（上限 20）/
`outputStatuses` を**エントリ側に持っている**。フック（`onReport` / `onOutputWarn` /
`onOutputStatus`）は ws-handler が付け外しするだけで、**外れていても記録は溜まる**。

つまり「閉じている間に受信したスプールを後から読む」土台は**もうある**。

## F2. 出力設定はサーバー設定由来のときしか供給されない

`config-resolver.ts:122-124`:

```ts
// printer 出力はサーバー設定由来のセッションからのみ供給する（信頼境界の 5 層目）
const printerOutput = source === "server" && session ? toPrinterOutput(session) : undefined;
```

`ws-handler.ts` の直接接続経路は `opts.output` を**設定しない**（コメントに
「任意パス書込・任意コマンド実行の防止」）。

→ **「常駐の条件＝`opts.output` があること」で、信頼境界とちょうど重なる。**
新しい判定軸を足す必要がない。

## F3. `WatchRegistry` は dtaq 専用の中身を持つ

`kind` フィールドは `"dtaq"` 固定の型で、実装は `DtaqConnection` / `DtaqWatchSpec` /
`read({ wait: -1 })` のループ・`history`（`WatchEntryView`）に密着している。

「**後から乗せられる形**」とは `kind` という**名前の余地**があるという意味で、
プリンターを入れる受け皿が実装されているわけではない。

一方 `WatchRegistry` の冒頭は設計原則を明記している:

> `SessionManager` の寿命の規則は「WS 切断＝破棄」「アイドルで掃除」……
> **寿命の異なるものを同じ箱に入れない。**

## F4. 通知の置き場は「まだ無い」

`outputWarnings` は `PrinterEntry` の中だけ。外へ出る道は **WS の 1 本**しかない
（`ws-handler.ts:398` が接続時に `outputWarnings` を載せて送る）。

- HTTP の一覧 API は無い（`/api/sessions` 相当を探したが printer の警告は出ていない）
- `printerLog.warn(message)` は出ている（`session-manager.ts:685`）——
  **サーバーのログには残る**。運用者は見られるが、利用者は見ない

→ 「誰も見ない」のは**ブラウザを開かない限り**という意味で、ログには出ている。
足りないのは**ブラウザを開いたときに気づける形**と、**開かずに確かめる手段**。

## F5. 明示停止の手段

`SessionManager.close(id)` があり、WS の `close` メッセージから叩ける。
常駐にしても**この経路は残る**ので、新しい停止手段を作る必要はない
——ただし「常駐中のプリンターの id」を知る手段が要る（F4 の一覧と同じ問題）。

## F6. 上限 8 の実態

`maxSessions` の既定は `app.ts` で決まる。`size` は表示＋プリンターの合計で、
`open()` / `openPrinter()` の入口で `SESSION_LIMIT` を投げる。

常駐プリンターが増えると**表示セッションが開けなくなる**。
「席が空いていない」と「ホストが落ちている」を区別するための設計（`open()` のコメント）は
そのままだが、**常駐が枠を食う**という新しい問題が出る。
