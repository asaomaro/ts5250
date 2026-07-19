# 仕様: 接続設定の分離（システム / セッション設定）

## 概要

1 つの接続設定に混在している「接続先＋資格情報」と「セッション固有の設定」を、
**システム（親）**と**セッション設定（子）**に分離する。すべての機能はシステムを参照して接続する。

既存ファイルは**読み込み時にメモリ上で分解**し、明示的な保存操作をしたときだけ新形式で書き出す。

## 設計方針

### D1: 保存ファイルは 2 つのまま。各ファイルが systems と sessions を持つ

`profiles.json`（サーバー設定・admin 専用）と `connections.json`（個人設定・所有者のみ）は
**信頼境界が違う**（research F5）。統合すると printer 出力設定の防御 1 層目が消える。
ファイルは分けたまま、それぞれの中を 2 階層にする。

```
profiles.json     { systems: [...], sessions: [...] }   ← admin のみ編集可。printer 出力を持てる
connections.json  { systems: [...], sessions: [...] }   ← 所有者のみ。printer 出力を持てない
```

### D2: 参照解決はファイル内に閉じる

**規則: セッション設定は、同じファイル内のシステムしか参照できない。**

これは**権限昇格への対策ではない**。個人設定のシステムは `owner` を持ち `assertOwner` で本人にしか
解決できないため、自分のセッションが解決するのは常に自分の資格情報であり、昇格の経路は設計上存在しない。

この規則の目的は**参照解決のスコープを明示すること**に限られる。価値は、後からファイル横断の
ルックアップヘルパが足されたときにスキーマ違反として検出できる点（安いので入れる）。

現行でも一般ユーザーはサーバー設定を使えない（`resolveConnectOptions` 冒頭の `assertProfileAccess`、
一覧も空配列。research F5・profiles.ts:185-193）。本規則はその性質を保つだけで、新たな防御ではない。

認証オフのときは `canEditProfiles` が無条件 true になる既存の扱い（app.ts:86-90）をそのまま踏襲する。

### D3: 参照は接頭辞つきの不透明トークンにする

`profiles` は `name` がキー、`connections` は `c-<uuid>` がキーで、**名前空間が衝突しうる**
（research A3）。API・MCP を通る参照は接頭辞を付けて一意にする。

```
srv:<name>     サーバー設定のシステム / セッション
own:<id>       個人設定のシステム / セッション
```

利用者に見せる文字列ではない（UI は名前を表示し、トークンは内部で持つ）。

### D4: 解決点を 1 つにする

research F2 のとおり、現在は解決関数が 2 つ・同じ三項分岐が 4 箇所に重複し、挙動が揃っていない。
**単一の `ConfigResolver` に集約**する。

```ts
resolveSystem(ref: string, user: AuthUser | undefined, warn?: (m: string) => void): ConnectOptions
resolveSession(ref: string, user: AuthUser | undefined, warn?: (m: string) => void): SessionConnectOptions
resolvePrinterOutput(sessionRef: string, user: AuthUser | undefined): PrinterOutputConfig | undefined
```

`warn` は**全経路で必ず配線する**（現状 5 経路中 3 経路が無言。research F2）。

## 対象範囲

| 層 | ファイル |
|---|---|
| サーバー・保存 | `profiles.ts`, `connection-store.ts` → `system-store.ts` / `session-store.ts` / `config-resolver.ts` へ再編 |
| サーバー・API | `connections.ts`, `app.ts`, `host-lists.ts` |
| サーバー・接続 | `ws-handler.ts`, `ws-messages.ts`, `mcp-tools.ts` |
| Web UI | `stores/connections.ts`, `stores/sessions.ts`, `stores/workspace.ts`, `ConnectView.vue`, `HostListPane.vue`, `App.vue`, `PaneTabs.vue` |
| スクリプト | `scripts/verify-mcp.mjs`, `scripts/verify-ws.mjs` |
| ドキュメント | `README.md`, `packages/server/README.md`, `AGENTS.md`, `packages/core/README.md`, `packages/web-ui/README.md`, `profiles.json.example` |

**対象外**: `secret-crypto.ts`（形式不変。再暗号化しない）、認証・権限モデルそのもの、DDM アップロード。

## インターフェース / データ構造

### システム

```ts
const systemSchema = z.object({
  id: z.string().min(1),              // srv: は name と同値、own: は s-<uuid>
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  tls: z.boolean().optional(),
  ccsid: z.number().int().optional(), // 既定 CCSID（セッションが上書き可）
  owner: z.string().optional(),       // connections.json のみ
  signon: z.object({
    user: z.string().min(1),
    passwordEnv: z.string().min(1).optional(),  // profiles.json のみ
    passwordEnc: z.string().optional()
  }).optional()
}).strict();
```

### セッション設定

```ts
const sessionConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  system: z.string().min(1),          // 同一ファイル内のシステム id
  sessionType: z.enum(["display", "printer"]),
  deviceName: z.string().optional(),
  screenSize: z.enum(["24x80", "27x132"]).optional(),  // display のみ
  ccsid: z.number().int().optional(), // システムの既定を上書き
  enhanced: z.boolean().optional(),   // display のみ
  owner: z.string().optional(),       // connections.json のみ
  printer: printerSchema.optional()   // profiles.json のみ。connections 側は .strict() で拒否
}).strict();
```

**個人セッション設定のスキーマには `printer` を含めない**（research F5 の 1 層目を維持）。
`.strict()` により、送られてきたら 400 になる。

### 資格情報の露出（不変条件）

一覧 API・MCP `list_*` は **`passwordEnc` / `passwordEnv` / `signon.user` / `printer` を返さない**。
返すのは `autoSignon: boolean` のような真偽値のみ。
システムは資格情報の集約点になるため、緩めると一発で漏れる（research A6）。

### MCP / WebSocket / REST の引数（3 系統を同時に変更）

```
open_session:          system? / session? / 直指定(host,port,tls,ccsid,screenSize,deviceName,enhanced) / readOnly
open_printer_session:  system? / session? / 直指定(host,port,tls,ccsid,deviceName)
signon:                sessionId(必須) / system(必須)
list_connections       → list_systems（システム一覧）/ list_session_configs（セッション設定一覧）
```

`list_sessions` は既存の「開いているセッション一覧」のまま。**名前が衝突するので新規はこの名を使わない**。

## 振る舞いの詳細

### B1: 参照の解決

| 指定 | 解決 |
|---|---|
| `session` のみ | セッション設定 → 親システム → 資格情報。**これが基本形** |
| `system` のみ | 装置名なしで接続（core で `deviceName` は optional。ホスト採番） |
| 両方 | **`session` の親が `system` と一致しなければエラー**（`CONFIG_ERROR`） |
| 直指定のみ | 従来どおり |
| いずれも無し | `CONNECT_FAILED: system, session, or host required` |

現行の「黙って `connection` が勝つ」（mcp-tools.ts:208-212）は、要件が問題視した混線の再生産なので**採らない**。

### B2: 移行（読み込み時）

旧形式を検出したら（トップレベルが `profiles` / `connections` 配列）、次の 3 段階で分解する。

1. **資格情報を持つ設定**を `(host, port ?? 既定, tls ?? false, signon.user)` で束ね、システムを作る
2. **資格情報を持たない設定**は、同じ `(host, port, tls)` のシステムが**ちょうど 1 つ**ならそこに属させる
3. 0 個または 2 個以上なら、資格情報なしのシステムを別に作る

規則 3 は誤結合の防止（同一 host に別ユーザーの設定がある環境で、意図しない権限で接続しないため）。

**システム名**: 既定は `host`。同一 host に複数できたときのみ `<host> (<user>)` で修飾。
**セッション設定名**: 元の設定名をそのまま引き継ぐ。

移行結果は `info` ログに要約を出す（何システム・何セッションになったか、束ねた対応）。

実データ（`profiles.local.json`）での期待結果 — **受け入れ基準とする**:

```
システム 1: name=pub400.com  host=pub400.com  tls=true  ccsid=939  signon.user=USER
  セッション pub400          display  device=WEBEMU01  screenSize=24x80
  セッション pub400-27x132   display  device=WEBEMUJP  screenSize=27x132  ccsid=1399
  セッション pub400-printer  printer  device=PRT_TEST  ccsid=1399  printer{autoPdfDir}
```

（`pub400-printer` は `signon` を持たないが、同 host のシステムが 1 つなので規則 2 で吸収される）

### B3: 書き戻し

**読み込みだけでは絶対に書かない。** 明示的な保存操作（POST/PUT/DELETE）が来たときに、
ファイル全体を新形式で書き出す。書き込みは既存どおり tmp → rename。

### B4: 暗号化

形式・鍵は不変（AES-256-GCM `v1:<iv>:<tag>:<ct>`）。
`passwordEnc` / `secretEnc` は同一形式なので、**移行時に再暗号化しない**。値をそのまま `signon.passwordEnc` へ移す。

### B5: Web UI — タブとシステムの対応

`GroupNode.tabs` は `string[]` のまま変えず、`workspaceStore` に対応表を追加する。

```ts
tabSystem: Record<string, string>   // タブ ID → システム id
```

- セッションタブ: そのセッション設定の親システム
- `list:*` タブ: 開いた時点で選択中のシステム
- `admin:*` タブ: 接続状況・ログは選択中システム。**アカウントは利用者名メニューへ移すのでタブにしない**

表示は `PaneTabs.vue` のレンダリング側でフィルタする。**タブは閉じない**（隠すだけ）。
システム切り替えでは `tabSystem` が一致するタブのみ描画し、`activeTab` がフィルタ外なら
そのシステムの先頭タブに寄せる。

### B6: Web UI — 画面構成

`ui-proposal.html`（第 3 版）を実装対象とする。

- ヘッダー: システム選択（接続本数を表示）と利用者名メニュー（アカウント / API トークン / ログアウト）
- システム未選択: システムのカード一覧
- システム選択後: セッションのカード + 「このシステムの機能」7 枚（ジョブ / オブジェクト / ユーザー /
  スプール / データ転送 / 接続状況 / ログ）
- 編集: **専用画面を作らない**。カードがその場で列いっぱいに開いてフォームになる
- タブ帯の `＋` でランチャーを再表示

### B7: ログの範囲

既定は選択中システム。範囲の選択肢に「すべてのシステム」「アプリ自身」を持つ。
**アプリ自身**（ログイン・認証失敗・トークン発行・アカウント変更）は
どのシステムにも属さないため、絞り込みで消してはならない。

### B8: 併せて直す既存不具合（research F9）

1. **`open_printer_session` がセッション設定の `deviceName` を読まない**（mcp-tools.ts:406）
   → 解決結果の `deviceName` を使い、引数指定があればそれを優先する
2. **`PaneTabs.vue` の `ADMIN_LABELS` に `list:*` が無い** → ラベルを追加し、
   `closeTab` でセッション切断へ流さない

F9 の 3（host-lists の 502）・4（未定義 CSS 変数）・5（README のツール数）は別テーマなので backlog へ。

## エラー処理 / 異常系

| 状況 | 挙動 |
|---|---|
| システム参照が存在しない | `SESSION_NOT_FOUND: system <ref> not found` |
| セッション参照が存在しない | `SESSION_NOT_FOUND: session <ref> not found` |
| セッションの親システムが存在しない | `CONFIG_ERROR: session <ref> references missing system <id>`（**移行後の整合性欠落を黙認しない**） |
| `system` と `session` の親が食い違う | `CONFIG_ERROR: session <ref> does not belong to system <ref>` |
| セッションがファイル外のシステムを参照 | `CONFIG_ERROR`（D2 のスコープ規定。読み込み時に検出して起動を止める） |
| 一般ユーザーがサーバー設定を参照 | `FORBIDDEN: server settings are admin only`（現行踏襲） |
| 他人の個人設定を参照 | `FORBIDDEN: not the owner of this session`（現行踏襲） |
| パスワード復号失敗 | エラーにせず自動サインオンをスキップし **`warn`（全経路で配線）** |
| `passwordEnv` 未設定 | `CONNECT_FAILED`（現行踏襲） |
| 旧形式に平文 `password` | 起動時に fail-fast（現行踏襲。profiles.ts:147-154） |
| 移行で誤結合の恐れ（規則 3 に該当） | 別システムとして分け、`warn` に理由を出す |

## ドメイン固有の考慮

- **信頼境界（AGENTS.md）**: printer 出力設定は `canEditProfiles` 経路のみ。個人設定スキーマに
  含めない。display 種別では破棄。`validatePrinter` の保存前検証を維持。5 層すべてを移行後に確認する
- **D13（認証情報を MCP 引数に取らない）**: 新引数はすべて参照名/ID のみ。`user` / `password` は登場しない
- **認証オフ時は 127.0.0.1 のみ待ち受け**（現行踏襲）

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| システムの CRUD（API・UI） | D1 のスキーマ + `/api/systems` + B6 のカード編集 |
| セッション設定がシステムを参照 | `sessionConfigSchema.system` |
| 旧形式がそのまま読める | B2。実データでの期待結果を基準とする |
| 5250 が従来どおり接続（実機） | B1 の `session` 単独指定で PUB400 に接続して確認 |
| プリンターが従来どおり接続（実機） | 同上（printer セッション） |
| 一覧・SQL がシステム指定だけで動く（実機） | B1 の `system` 単独指定で確認 |
| MCP が追従 | `system` / `session` へ置換。WS・REST も同時（research A3） |
| パスワードが 1 箇所 | システムの `signon` のみが保持。セッション側に欄を持たない |
| 既存テストが緑 | `mcp-list-connections.test.ts` 他を新モデルへ更新 |

## 未確定事項（plan / coding で決める）

- `lastConnectedAt` は死んでいる（research F3）。移行で落とすか実装するか
- `list_systems` / `list_session_configs` の最終的なツール名
- システム切り替え時、`activeTab` をどのタブに寄せるか（先頭 / 最後に見ていたもの）
