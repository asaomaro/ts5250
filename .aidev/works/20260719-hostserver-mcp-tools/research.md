# 調査: ホストサーバー機能の MCP 公開

requirement の「要検討」4 点を潰すための事前調査。**すべて実ファイルを直読して確認した事実**で、
推測は「未確認」と明記する。

## F1. MCP ツールの登録・認可モデル（確認済み）

- 登録は `packages/server/src/mcp-tools.ts` の `registerTools()`（`:177`）に集約。
  `registerTool` の呼び出しはリポジトリ全体でこのファイルのみ。
- 公開は `packages/server/src/app.ts:122` の `app.all("/mcp")`。コメントに
  **「ステートレス（接続はリクエスト毎に管理）」「認証時は per-request の認証ユーザーをツールに渡し、
  per-user 分離を効かせる」**と明記。リクエストごとに `buildMcpServer` を作り直している。
- `ToolDeps`（`mcp-tools.ts:24-31`）が持つのは `sessions` / `resolver`（ConfigResolver＝
  **接続設定の唯一の解決点**）/ `version` / `user`（未認証・認証 OFF は undefined）。
- **資格情報はツール引数に取らない**——`registerTools` の JSDoc に `D13` として明記
  （`:175`）。解決は `resolver.resolve({ system, session }, user, warn).connect`（`:182-183`）で、
  認可・復号はすべて ConfigResolver 内に閉じている。
- 共通ヘルパ: `errorResult(err)`（`:162`。`Tn5250Error` なら `err.code`、それ以外は
  `INTERNAL_ERROR`。`isError` + `structuredContent.error`）、`withAudit({ op }, fn)`（`:20`）。

→ **新ツールもこの型に従えばよい**。独自の認可分岐を書かない（AGENTS.md §5「認可はストア側の
単一関数に集約し、呼び出し元に条件分岐を書かない」）。

## F2. ホストサーバー接続の既存の作り方（確認済み・最重要の前例）

`packages/server/src/host-lists.ts` が**サーバー側でホストサーバー接続を張る唯一の既存実装**。
そのまま踏襲できる。

```ts
// host-lists.ts:143-156 — 一覧・操作に使うコマンドサーバー接続を開く
async function openCommand(opts: ConnectOptions): Promise<CommandConnection> {
  if (!opts.host || !opts.user || !opts.password) {
    throw new Tn5250Error("CONFIG_ERROR",
      "この接続設定にはユーザーとパスワードが登録されていないため一覧を取得できません");
  }
  return CommandConnection.connect({
    host: opts.host, user: opts.user, password: opts.password,
    ...(opts.tls !== undefined ? { tls: opts.tls as boolean } : {})
  });
}
```

要点:

1. **5250 の自動サインオン情報を流用する**（`:140` のコメント。「同じ相手に同じ資格情報で繋ぐため」）。
   ホストサーバー専用の資格情報の置き場を新設しない。
2. **接続はリクエスト単位で開いて `finally` で閉じる**（`:199-215`、`:227-247` の
   `let conn … finally { conn?.close() }`）。プールも長命セッションも持っていない。
3. 参照は `system` / `session` のどちらでもよく、**system だけで足りる**
   （`:26-27` のコメント「コマンドサーバーは装置名も画面サイズも使わないため」）。
4. エラーは `Tn5250Error.code` を HTTP に写す（`statusOf`。`:95-107`）。
   **502 は「上流との通信失敗」に限る**という明示的な設計方針がある。

→ requirement 要検討 1（接続のライフサイクル）は、**(a) 単発完結が既存前例と一致**する。
   (b) セッションモデル・(c) プールは前例が無く、導入するなら別途根拠が要る。
   ただし SQL は接続確立コストが効く可能性があるため、**実機で接続時間を実測してから確定**する
   （未確認: ホストサーバー接続 1 回あたりの所要時間）。

## F3. 任意 CL 実行の可否（requirement 要検討 2）

**事実として確認できたこと:**

- `/api/host/action` は任意 CL を**意図的に拒否**している。`host-lists.ts:65` のコメント
  「実行する CL コマンド。**この API が組み立てる**（利用側から任意の CL は受け取らない）」。
  `actionSchema.action` は 4 値の `z.enum`（`:66`）で、CL 文字列は `buildCommand()`（`:159-183`）
  がサーバー側で組み立てる。
- 一方で同じファイルの冒頭コメント（`:4-6`）は逆向きの原則を述べている——
  **「接続を持つユーザーなら誰でも使える——見える範囲は IBM i の権限が決めるため、
  アプリ側で追加の制限は掛けない」**。
- MCP には既に `run_steps`（`mcp-tools.ts:736`）があり、**5250 のコマンド行に任意の CL を
  打ち込める**。`get_job_info`（`:792`）は実際に「DSPJOB を実行して F3 で戻る」実装である。

**評価:** この 2 つは矛盾ではなく**対象読者が違う**。`/api/host/action` はブラウザ（一般ユーザーを
含む）向けで、UI のボタンに対応する操作だけを受ける。MCP は API トークンを持つ自動化向けで、
既に任意 CL 実行の能力を（5250 経由で）与えている。

→ **MCP に任意 CL を出しても新たな権限は増えない**（既に `run_steps` で可能）。
   むしろ経路を塞ぐと「5250 を介せばできるのにホストサーバー経由ではできない」という、
   利用者から見て理由の説明できない非対称が残る。
   **ただしこれは spec で結論として記録し、decisions.md に根拠を残すこと**（requirement の指示）。
   「MCP だから許す」ではなく「**既存の `run_steps` で同じことが可能であり、
   権限境界は IBM i 側が決める**」が根拠である。

## F4. 秘密の扱い（確認済み）

- AGENTS.md §4「秘密の扱い」: API/ブラウザには**平文も暗号文も返さない**。ログにも値を出さない。
- `mcp-tools.ts` の D13（F1）どおり、**ツール引数に host 以外の資格情報を取らない**方針。
  `open_session` は `host`/`port`/`tls` の直接指定を許すが、user/password は許していない
  （`:198-209` の inputSchema に無い）。
- → 新ツールも **`system` / `session` 参照のみ**を受ける。直接ホスト指定を許すかは spec で決めるが、
  許す場合でも資格情報は受けない（＝資格情報の無い直接指定は `CONFIG_ERROR`）。

## F5. core の API 表面（確認済み。要点のみ）

すべて `packages/core/src/index.ts` から export 済み。**接続オプションの形は 4 種でほぼ共通**——
`{ host, user, password, port?, tls?, resolvePort?, timeoutMs? }`。CCSID を持つのは NetPrint だけ。

| 機能 | 接続クラス | 主なメソッド |
|---|---|---|
| SQL | `DbConnection.connect(DbConnectOptions)` | `query(conn, sql, {blockSize?})` → `{columns: ColumnMeta[], rows: Row[]}` / `stream(...)` |
| コマンド | `CommandConnection.connect(CommandConnectOptions)` | `run(cl)` → `CommandResult{success, returnCode, messages: HostMessage[]}` / `runOrThrow` / `call(program, library, params)` |
| スプール一覧 | **`CommandConnection`**（NetPrint ではない） | `listSpooledFiles(conn, SpoolListFilter, {max?})` → `SpoolEntry[]` |
| スプール取得 | `NetPrintConnection.connect(NetPrintConnectOptions)` | `readSpooledFileRaw(SpoolId)` / `readSpooledPages` / `readSpooledText` |
| IFS | `IfsConnection.connect(IfsConnectOptions)` | `readFile(path)` / `writeFile(path, data, {create?})` / `deleteFile(path)` |
| 一覧 | `CommandConnection` | `listJobs` / `listObjects` / `listUsers`（`(conn, filter, {max?})`） |

**設計に効く事実（要注意）:**

1. **SQL は SELECT 専用**。`query.ts:22-27` に「SELECT を指定しないと拡張列メタデータが返らない」
   とあり、`STATEMENT_TYPE_SELECT` / `OPEN_ATTR_SELECT` を固定で送っている。
   **INSERT/UPDATE/DELETE/DDL は現状の `query` では実行できない**。
   → ツールの説明文で明示する。更新が要るなら CL の `RUNSQL` 経由になる（spec で触れる）
2. **スプールの一覧と取得で接続クラスが違う**（一覧＝Command / 取得＝NetPrint）。
   「一覧して選んで取得」を 1 ツールにすると 2 接続を張ることになる。ツール分割の判断材料
3. **各 `connect()` は内部で必ず `signon()` を先に呼ぶ**（passwordLevel の取得のため）。
   つまり **1 回の操作で signon サーバー＋目的サーバーの 2 接続**が張られる。
   単発完結モデルのコストはここに効く → 実機で実測する（F2 の未確認事項）
4. `close()` は冪等、closed 後の操作は `SESSION_CLOSED`。
   呼び出し側の正しい形は `try { … } finally { conn.close() }`（`host-lists.ts` と tools の実例が一致）
5. 型名の注意（当初の想定と実物が違った）: `SpooledFileInfo` ではなく **`SpoolEntry`**、
   `CommandMessage` ではなく **`HostMessage`**
6. エラーは `Tn5250Error`（`code: ErrorCode`）。hostserver が投げるのは
   `CONNECT_FAILED` / `TLS_CERT_INVALID` / `CONFIG_ERROR` / `UNAUTHENTICATED` / `PROTOCOL_ERROR` /
   `HOST_SERVER_UNSUPPORTED` / `SESSION_CLOSED` / `SQL_ERROR` / `COMMAND_FAILED`。
   サブクラス `SqlError`（`sqlCode` / `sqlState`）・`CommandError`（`command` / `result` / `primary`）は
   **追加情報を持つので応答に載せる価値がある**
7. 既定値: `query` の `blockSize` 100 / `listSpooledFiles` の `max` 100 /
   `listJobs` 100・`listObjects` 200・`listUsers` 200 / NetPrint の CCSID 273 /
   読み取り上限 `MAX_SPOOL_BYTES` 64MiB / `timeoutMs` 20,000

**利用例の実物**（`tools/hostserver-check/src/sql.ts:24-50`。この形をそのまま踏襲する）:

```ts
const conn = await DbConnection.connect({ host, user, password, tls: useTls });
try {
  const r = await query(conn, sql);
  // r.columns[].name/typeName/…、r.rows[] は Record<string, string|number|bigint|null>
} finally {
  conn.close();
}
```

## 未確認・要実機確認

- ホストサーバー接続 1 回あたりの確立時間（単発完結で許容できるか）
- SQL 結果セットが大きい場合の MCP 応答サイズの実態
- `stream`（逐次取得）はブロッキング係数を跨ぐ規模が**未検証**（backlog 記載）。
  本作業では**この未検証経路に依存しない**設計にする
- MSGW 系は core のコメント（`netprint-connection.ts:264,319`）に「⚠ 実際の MSGW に対しては未検証」
  とあり、requirement で対象外と決めている
