# 仕様: ホストサーバー機能の MCP ツール公開

requirement / research を受けた実装仕様。research の F1〜F5 を根拠として参照する。

## 1. 全体方針

**既存の `host-lists.ts` と `mcp-tools.ts` の型をそのまま踏襲する。新しい枠組みを作らない。**

- 接続は **単発完結**（リクエストごとに `connect` → 操作 → `finally { close() }`）。
  根拠: `host-lists.ts:199-215` の既存実装がこの形であり、`/mcp` 自体が
  「ステートレス（接続はリクエスト毎に管理）」と宣言している（`app.ts:120`）。
  プール・長命セッションは前例が無く、導入するなら実測に基づく根拠が要る（→ D2）。
- 資格情報は **ツール引数に取らない**（D13）。`system` / `session` 参照を
  `ConfigResolver` に渡して解決する。
- 認可は **サーバー側**（`ConfigResolver` 内）で閉じる。ツール側に条件分岐を書かない
  （AGENTS.md §5）。
- エラーは既存 `errorResult(err)` に通す。`Tn5250Error.code` がそのまま MCP に出る。

## 2. ファイル構成

```
packages/server/src/
  host-server-tools.ts   ← 新規。ホストサーバー系 MCP ツールの登録
  host-connect.ts        ← 新規。ConnectOptions → 各 XxxConnection を開く共通ヘルパ
  mcp-tools.ts           ← registerHostServerTools() を呼ぶ 1 行を追加
  host-lists.ts          ← openCommand を host-connect.ts へ移して共有（重複を残さない）
```

`mcp-tools.ts` は既に 800 行超で、5250 の関心事で満ちている。**経路が違うものを同居させない**
（ファイルを分けることで「このツールはホストサーバー経由」がファイル単位で自明になる）。

### `host-connect.ts`（共通ヘルパ）

`host-lists.ts:143-156` の `openCommand` を一般化して移設する。4 種すべてで
接続オプションの形が共通（research F5）なので、資格情報の検証は 1 箇所に集約できる。

```ts
/** ConnectOptions（5250 の接続設定）→ ホストサーバー接続の共通オプション。
 *  **5250 の自動サインオン情報を流用する**——同じ相手に同じ資格情報で繋ぐため（host-lists.ts の踏襲）。 */
export function hostOptsFrom(opts: ConnectOptions): { host: string; user: string; password: string; tls?: boolean }
export function openCommand(opts: ConnectOptions): Promise<CommandConnection>
export function openDb(opts: ConnectOptions): Promise<DbConnection>
export function openNetPrint(opts: ConnectOptions, ccsid?: number): Promise<NetPrintConnection>
export function openIfs(opts: ConnectOptions): Promise<IfsConnection>
```

資格情報が無い接続設定は `CONFIG_ERROR`（既存メッセージを踏襲）。

## 3. 公開するツール

**命名規則: すべて `host_` 接頭辞**。これで既存の 5250 系（`list_spools` 等）と経路が
一目で区別できる（受け入れ基準）。既存ツール名は変更しない（後方互換）。

共通入力（全ツール）:

```ts
system: z.string().optional(),   // srv:<name> / own:<id>
session: z.string().optional()   // セッション設定を指定しても親システムに解決される
// どちらか必須（未指定は CONFIG_ERROR）
```

### 3.1 `host_sql` — SELECT の実行

| 項目 | 内容 |
|---|---|
| 入力 | `sql: string`, `maxRows?: number`（既定 200・上限 1000） |
| 出力 | `columns: {name,typeName,length,scale,precision,ccsid,nullable}[]`, `rows: Record<string,…>[]`, `rowCount: number`, `truncated: boolean` |

- **SELECT 専用であることを description に明記する**（research F5-1。`query` は
  `STATEMENT_TYPE_SELECT` を固定で送るため INSERT/UPDATE/DDL は通らない）。
  更新が必要なら `host_command` で `RUNSQL` を使う旨も書く。
- `maxRows` は **`blockSize` とは別概念**。`stream` はブロッキング係数を跨ぐ規模が未検証
  （backlog 記載）なので**使わない**。`query` の結果を上限で切り、切ったら `truncated: true` を返す。
  → 未検証の経路に依存しない（requirement 要検討 4）。
- `SqlError` は `sqlCode` / `sqlState` を `structuredContent.error` に載せる（research F5-6）。
  これは `errorResult` の拡張が要る（→ 3.7）。

### 3.2 `host_command` — CL コマンドの実行

| 項目 | 内容 |
|---|---|
| 入力 | `command: string` |
| 出力 | `success: boolean`, `returnCode: number`, `messages: {id,text,severity,kind}[]` |

- **任意の CL を受け取る**。根拠は D1（下記）。`conn.run()` を使い、失敗を例外にしない
  （メッセージを返すほうが AI にとって有用。`host-lists.ts:231` と同じ選択）。
- description に「対話型コマンド（画面を出すもの）は扱えない」と明記する
  （コマンドサーバーは非対話のみ。`20260718-hostserver-command` requirement の対象外事項）。

### 3.3 `host_call_program` — プログラム呼び出し

| 項目 | 内容 |
|---|---|
| 入力 | `program: string`, `library: string`, `params: ({type:"in",dataBase64:string}｜{type:"out",length:number}｜{type:"inout",dataBase64:string,length:number}｜{type:"null"})[]` |
| 出力 | `success`, `returnCode`, `messages`, `outputs: (string｜null)[]`（Base64） |

- バイト列は **Base64 文字列**で受け渡す（MCP は JSON。`Uint8Array` を直接運べない）。
- **出力パラメータは要求順で返る前提**に依存している（`20260718-hostserver-command` review で
  コメント明記済みの前提）。description にもこの前提を書く。

### 3.4 `host_list_spools` / `host_get_spool` — スプール（pull 型）

**既存の `list_spools`（push 型・プリンターセッション由来）とは別物**。両方の description に
相互参照を書き、取り違えを防ぐ（受け入れ基準）。

`host_list_spools`:

| 項目 | 内容 |
|---|---|
| 入力 | `filter?: {user?,outputQueue?,outputQueueLibrary?,status?,formType?,userData?}`, `max?: number`（既定 100・上限 1000） |
| 出力 | `items: SpoolEntry[]`（`SpoolId` の 5 項目＋状態・ページ数・日時等） |

`host_get_spool`:

| 項目 | 内容 |
|---|---|
| 入力 | `id: {jobName,jobUser,jobNumber,fileName,fileNumber}`, `format?: "text"｜"pages"`（既定 `text`）, `ccsid?: number` |
| 出力 | `format` に応じ `lines: string[]` または `pages: {rows,cols,lines[]}[]` |

- **一覧と取得で接続クラスが違う**（一覧＝Command / 取得＝NetPrint。research F5-2）。
  だからツールを 2 本に分ける——1 本にすると 1 回の呼び出しで 2 接続を張ることになる。
- `ccsid` を入力に持つのは NetPrint だけ（既定 273）。日本語環境向けに指定可能にする
  （`20260718-hostserver-spool` review で「経路によって扱いが違う」と指摘され修正済みの経緯を踏襲）。
- PDF 化は **本作業の対象外**（`renderSpoolPdf` は `pages` から作れるが、MCP で
  バイナリを返す設計は別途必要。Web UI 作業で扱う）。

### 3.5 `host_read_file` / `host_write_file` — IFS

| ツール | 入力 | 出力 |
|---|---|---|
| `host_read_file` | `path: string`, `encoding?: "utf8"｜"base64"`（既定 `utf8`） | `content: string`, `bytes: number` |
| `host_write_file` | `path: string`, `content: string`, `encoding?`, `create?: boolean` | `bytes: number` |

- `deleteFile` は**公開しない**。破壊的操作で、CL の `RMVLNK` が `host_command` で使える。
  ツール表面を増やさない（→ D3）。
- ディレクトリ操作は core に無い（backlog の未検証項目）。description で「親ディレクトリが
  無い場合は失敗する」ことに触れる。

### 3.6 `host_list_jobs` / `host_list_objects` / `host_list_users`

core の `listJobs` / `listObjects` / `listUsers` をそのまま。入力は各 `*ListFilter` ＋ `max`。
HTTP API（`/api/host/list/:kind`）と**同じ core 関数を呼ぶだけ**で、独自ロジックを持たない。

### 3.7 `errorResult` の拡張

`SqlError` の `sqlCode` / `sqlState`、`CommandError` の `primary` を
`structuredContent.error` に含める。既存 `errorResult`（`mcp-tools.ts:162`）を拡張し、
5250 系の既存挙動は変えない（追加フィールドのみ）。

## 4. 決定事項（decisions.md に転記）

### D1. 任意 CL の実行を MCP に許可する

**決定**: `host_command` は任意の CL 文字列を受け取る。

**根拠**（research F3。自分で決めた規則を理由にしない）:

1. **新たな権限を増やさない**。MCP には既に `run_steps` があり、5250 のコマンド行に
   任意の CL を打ち込める（`get_job_info` は実際に DSPJOB をそう実行している）。
   ホストサーバー経由を塞いでも、同じことが 5250 経由で可能なまま残る。
2. **権限境界は IBM i が持つ**。`host-lists.ts:4-6` が既に採っている原則——
   「見える範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない」。
   資格情報の持ち主にできること以上のことはできない。
3. `/api/host/action` が任意 CL を拒むのは**対象読者が違うから**であり、
   本件と矛盾しない。あちらはブラウザ（一般ユーザーを含む）向けで UI のボタンに対応する
   操作だけを受ける。MCP は API トークンを持つ自動化向け。

**残るリスクと扱い**: 破壊的 CL（`DLTLIB` 等）が実行可能になる。これは 1・2 より
**既に成立している状態**であり本作業で新設される危険ではない。監査のため `withAudit` を通す。

### D2. 接続は単発完結（プールしない）

**決定**: ツール呼び出しごとに接続を張り、`finally` で閉じる。

**根拠**: `host-lists.ts` の既存実装と `/mcp` のステートレス宣言に一致する。
**ただしコストは未実測**——research F5-3 のとおり 1 操作あたり signon＋目的サーバーの
**2 接続**が張られる。test 工程で実機の所要時間を測り、実用に耐えない場合は
plan に戻して再検討する（そのときは**実測値を根拠に**プールを導入する）。

### D3. 破壊的操作をツール表面に出さない

**決定**: `deleteFile`（IFS 削除）を専用ツールにしない。

**根拠**: D1 で任意 CL を許すため `RMVLNK` で実行できる。専用ツールを足すと
「AI が誤って選びやすい破壊的ボタン」を増やすだけで、能力は増えない。
**能力を増やさない表面は足さない。**

### D4. MSGW は公開しない

requirement の対象外事項どおり。core のコメント（`netprint-connection.ts:264,319`）に
「⚠ 実際の MSGW に対しては未検証」とあり、`answerMessage` は応答文字列のみ可変長で
送っている疑いが残る。**未検証のものを AI から叩けるようにしない。**

## 5. 受け入れ基準（検証可能な形）

- [ ] `host_` 接頭辞のツールが 10 本登録される
      （sql / command / call_program / list_spools / get_spool / read_file / write_file /
      list_jobs / list_objects / list_users）
- [ ] 既存 19 ツールの名前・挙動が変わっていない（回帰テスト）
- [ ] `system` / `session` のどちらも未指定なら `CONFIG_ERROR`
- [ ] 資格情報の無い接続設定では `CONFIG_ERROR`（メッセージは既存踏襲）
- [ ] 一般ユーザーが `srv:` を名指ししても `ConfigResolver` が `FORBIDDEN` にする（認可の回帰）
- [ ] ツール引数のスキーマに user / password が**存在しない**
- [ ] 応答・ログに平文の資格情報が出ない
- [ ] `SqlError` の `sqlCode` / `sqlState` がエラー応答に含まれる
- [ ] **実機（PUB400）で 10 本すべてを実際に叩いて確認**し、接続の所要時間を記録する（D2）
- [ ] 単体テスト追加 / `tsc -b` 通過 / lint クリーン / 既存テスト緑
