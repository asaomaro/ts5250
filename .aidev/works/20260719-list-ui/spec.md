# 仕様: ジョブ・オブジェクト・ユーザー一覧の Web UI

## 設計方針

### D1: 管理画面と同じ「特殊なタブ ID」方式に乗せる
既存の `admin:users` / `admin:sessions` / `admin:logs` と同じく、
`list:jobs` / `list:objects` / `list:users` というタブ ID でワークスペースに開く。
**新しい概念を増やさない**——ペイン機構・タブ管理・キーボード操作がそのまま効く。

### D2: 任意の CL を受け取らない
操作は `job-hold` / `job-release` / `job-end` / `object-delete` の**列挙**で受け取り、
CL コマンドは**サーバー側で組み立てる**。
利用側から任意のコマンド文字列を受け取ると、実質的にリモート実行の口になる。

### D3: 見える範囲は IBM i の権限に委ねる
接続を持つユーザーなら誰でも使える。アプリ側で追加の制限は掛けない。
実機で確認済み——一般ユーザーは自分のジョブしか見えない。

### D4: 資格情報はサーバーに留める
既存の接続設定（`connection` / `profile`）を ID で指定し、
サーバー側で解決する。ブラウザへ資格情報を渡さない。

## 対象範囲

- 新規 `packages/server/src/host-lists.ts` — 一覧・操作の API
- 新規 `packages/web-ui/src/components/HostListPane.vue` — ペイン
- 変更 `app.ts`（ルート登録）/ `WorkspaceNode.vue`（ペイン描画）/ `App.vue`（ナビ）

## API

```
POST /api/host/list/{jobs|objects|users}
  { source: {connection|profile}, jobs?/objects?/users?: filter, max?: number }
  → { items: [...] } / 502 { error, code }

POST /api/host/action
  { source, action: "job-hold"|"job-release"|"job-end"|"object-delete", target }
  → { success, command, messages: [{id,text,severity,kind}] }
```

## エラー処理

- 入力の不正は 400（zod `.strict()`）
- ホスト側の失敗は 502 に `code` を添える
- 操作の失敗は**成功扱いで返し**、`success: false` とメッセージ ID を返す
  （IBM i のメッセージは失敗の説明であって通信の失敗ではない）
