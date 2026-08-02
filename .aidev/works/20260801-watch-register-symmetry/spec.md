# 仕様: 待ち行列サービスの非対称性を直す

## 設計方針

### プリンターと同じ「登録 → 開始」の 2 段にする

```ts
// 登録だけ（接続しない）。`openPrinter({ autoStart: false })` に当たる
register(opts): WatchView          // state: "stopped"
// 開始（接続する）。失敗は `error` 状態として残す
resume(id): Promise<void>
```

`start()` は**この 2 つの組み合わせ**として書き直す。手動開始の契約
（最初の接続を待って呼び出し側に返す）は変えない——変わるのは
**失敗しても実体が残る**ことだけ。

### `resume` の失敗を状態に残す

以前は `openConn` の例外がそのまま抜け、**状態は `stopped` のまま・理由はどこにも無い**
だった。`SessionManager.startPrinter` と同じく `error` ＋ 理由を立ててから投げる。

### `register` はイベントを配らない

登録は組み立ての途中で、外から見て意味を持つのは**そのあとの状態変化**
（`stopped` → `listening` / `error`）のほう。一覧の配り直しは行が増減したとき
（`remove` / `update`）に任せる。

## 振る舞いの変化

| | 以前 | いま |
|---|---|---|
| 開始に成功 | `listening` で登録（状態イベント無し） | `stopped` で登録 → `listening`（**状態イベント 1 つ増える**） |
| 開始に失敗 | **実体を作らない**・理由はログだけ | **実体が残る**（`error` ＋ 理由） |
| 失敗が枠を食うか | （実体が無いので該当なし） | 食わない（`listeningCount` は数えない） |

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 失敗後に理由が残る | `resume` の `setState(w, "error", …)` |
| 枠を食わない | `listeningCount` が `error` を数えない（既存） |
| 実機の通し | `verify-browser-watch.mjs` 16 件 |
