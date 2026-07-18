# 仕様: 接続設定のサーバー一元管理

## 概要
ユーザーが作成する接続設定を localStorage からサーバー保存へ移す。認証オフ＝全接続を誰でも CRUD、
認証オン＝自分の接続のみ。自動サインオンのパスワードは **AES-256-GCM で暗号化**して保存し（master key は
`.env` の `AS400_SECRET_KEY`）、接続時にサーバー内で復号して signon に使う。運用者管理の `profiles.json`
（共有・読み取り専用・信頼設定）は存続。保存済み接続は **ID 参照で開く**（raw 資格情報をブラウザから送らない）。

## 設計方針
- 既存 `UserStore`（JSON＋`byId` マップ＋tmp→rename atomic save）と `assertOwner` を鏡写しに `ConnectionStore` を新設。
- 既存の「open は profile 参照でサーバー内解決」経路（`resolveConnectOptions`）に、**接続 ID 参照**を合流させる。
- 信頼境界は「ユーザー接続スキーマに printer 出力系フィールドを持たせない」ことで機械的に担保（zod strict）。
- 暗号は Node 標準 `crypto`（新規依存なし）。master key は環境変数から読み、コード・レコードに鍵を持たない。

## 対象範囲
### 追加
- `packages/server/src/secret-crypto.ts`（新）: AES-256-GCM の encrypt/decrypt と master key ロード。
- `packages/server/src/connection-store.ts`（新）: `ConnectionStore` クラス＋zod スキーマ。
- `packages/server/src/connections.ts`（新）: `/api/connections` の CRUD ルート登録。
- `packages/web-ui/src/stores/connections.ts`（新）: API バックドのストア（`settings.ts` を置換）。
### 変更
- `packages/server/src/app.ts`: `registerConnectionRoutes` を配線。
- `packages/server/src/ws-handler.ts`: open の**接続 ID 参照**解決を追加（`onOpen`/`onOpenPrinter`）。
- `packages/server/src/mcp-tools.ts` / `mcp-server.ts`: open 系ツールに接続 ID 参照を通す（deps に connections 追加）。
- `packages/server/src/main.ts`: `--connections <file>` 配線、master key ロード、deps へ注入。
- `packages/web-ui/src/components/ConnectView.vue`: 保存/編集/削除を API 化、開くを ID 参照化、パスワードは値送信＋`hasSecret` 表示。
- 型共有（`WsClientMessage` の open に `connection?: string` を追加）。
### 削除
- `packages/web-ui/src/stores/settings.ts` の localStorage 接続 CRUD（ストアごと connections.ts へ置換）。
  ※ カード/一覧トグルの表示設定（`as400.connectView`）は接続データではないため localStorage 維持で可。

## インターフェース / データ構造

### ConnectionRecord（保存・zod strict）
```ts
{
  id: string;                 // 例 "c-<uuid>"
  owner?: string;             // 認証オン=username。認証オフ作成時は省略（= 共有/無主）
  name: string;
  host: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  tls?: boolean;
  sessionType: "display" | "printer";
  autoSignon?: boolean;
  signonUser?: string;
  secretEnc?: string;         // AES-256-GCM 暗号文 "ivB64:tagB64:ctB64"（平文は保存しない）
  // printer 出力系（autoPdfDir/autoPrint/pdfFontPath 等）は "持たない"（strict で拒否）
  lastConnectedAt?: number;
}
```
ファイル: `connections.json` = `{ connections: ConnectionRecord[] }`。

### PublicConnection（API 露出・秘密を含まない）
```ts
{
  id; owner?; name; host; port?; ccsid?; screenSize?; deviceName?; tls?;
  sessionType; autoSignon?; signonUser?;
  hasSecret: boolean;         // secretEnc の有無だけ返す（暗号文も返さない）
}
```

### ConnectionStore（`connection-store.ts`）
```ts
class ConnectionStore {
  static fromFile(path: string, crypto?: SecretCrypto): ConnectionStore;
  listForUser(user?: AuthUser): PublicConnection[];      // 認証オフ=全件 / オン=owner一致(+admin全件)
  get(id: string): ConnectionRecord;                     // 無ければ SESSION_NOT_FOUND
  add(input: ConnectionInput, user?: AuthUser): PublicConnection;   // owner=user?.username, id採番, password→暗号化
  update(id: string, input: ConnectionInput, user?: AuthUser): PublicConnection; // assertOwner後に更新
  remove(id: string, user?: AuthUser): void;             // assertOwner後に削除
  resolveConnectOptions(id: string, user?: AuthUser): ConnectOptions; // assertOwner後, secretEnc復号→password
  save(): Promise<void>;                                  // tmp→rename atomic
}
```
- `ConnectionInput`（API 受理）: ConnectionRecord から `id/owner/secretEnc/lastConnectedAt` を除き、
  代わりに `password?: string`（平文・保存時に暗号化）を受ける。**printer 出力系キーは zod strict で拒否**。
- 認可は各メソッド内で `assertOwner(record.owner, user)` を通す（一覧は listForUser がフィルタ）。

### SecretCrypto（`secret-crypto.ts`）
```ts
class SecretCrypto {
  static fromEnv(envName = "AS400_SECRET_KEY"): SecretCrypto | undefined; // 鍵未設定なら undefined
  encrypt(plain: string): string;   // "ivB64:tagB64:ctB64"（AES-256-GCM, 乱数IV 12B, tag 16B）
  decrypt(blob: string): string;
}
```
- master key: `process.env.AS400_SECRET_KEY`。**base64 か hex の 32byte**を受理（長さ検証、不正なら起動エラー）。
- 鍵未設定（undefined）時: 自動サインオンの**パスワード保存を拒否**（API 400）。`secretEnc` を持つ既存レコードの
  復号は不可となるため、resolve 時は password 無しで開く（signon 画面に着地）。接続自体は可能。

### REST API（`/api/connections`・認証ミドルウェア配下）
| メソッド | パス | 動作 |
|---|---|---|
| GET | `/api/connections` | `listForUser(c.get("user"))` を返す |
| POST | `/api/connections` | `add(body, user)` → 201＋PublicConnection |
| PUT | `/api/connections/:id` | `update(id, body, user)` → PublicConnection |
| DELETE | `/api/connections/:id` | `remove(id, user)` → `{ ok: true }` |
- 保存後に `store.save()`。エラー変換は既存 `app.ts` 準拠（FORBIDDEN→403 / SESSION_NOT_FOUND→404 / zod→400）。
- パスワードは POST/PUT の body でのみ受け、レスポンスには一切含めない（`hasSecret` のみ）。

### WS open（接続 ID 参照）
- `WsClientMessage` の open に `connection?: string` を追加。
- `ws-handler onOpen`（表示）: `msg.connection` があれば
  `{ ...deps.connections.resolveConnectOptions(msg.connection, this.user), origin: msg.connection }`。
  優先順位は `connection` → `profile` → direct。
- `onOpenPrinter`（プリンター）: 同様に `connection` を解決し host/ccsid 等を設定。**printer 出力設定は
  ユーザー接続には無い**ため、`resolvePrinterOutput` は profile 参照時のみ（現状維持）。
- resolve 内で `assertOwner` を通すため、他人の接続 ID を指定しても FORBIDDEN。

## 振る舞いの詳細
```mermaid
sequenceDiagram
  participant UI as web-ui
  participant API as /api/connections
  participant CS as ConnectionStore
  participant WS as /ws
  UI->>API: POST {name,host,...,autoSignon,signonUser,password}
  API->>CS: add(input, user)
  CS->>CS: password→SecretCrypto.encrypt→secretEnc
  CS-->>API: PublicConnection(hasSecret=true)
  API-->>UI: 201 (no secret)
  UI->>WS: open {connection: id, kind?}
  WS->>CS: resolveConnectOptions(id, user)
  CS->>CS: assertOwner; secretEnc→decrypt→password
  CS-->>WS: ConnectOptions(user/password 内部のみ)
  WS-->>UI: opened/printer-opened
```
- 認証オフ: `user=undefined`。`add` は owner 省略で保存、`listForUser` は全件、`assertOwner` は全通過。
- 認証オン: 一覧・open・更新・削除すべて自分の owner に限定（admin は全件）。
- web-ui: 起動時に `GET /api/connections` を取得しストアに反映。フォーム保存/編集/削除は API 呼び出し後にストア更新。
  パスワード欄は autoSignon 時のみ表示。既存で `hasSecret=true` なら「設定済み（変更する場合のみ入力）」表示、
  空送信ならパスワード据え置き（update は password 未指定なら secretEnc を保持）。
- 開く: `ConnectView.connectSaved` は `openSession({type:"open", connection: c.id}, ...)`（printer は kind 付き）。

## ドメイン固有の考慮
- **信頼境界（安全不変条件）**: ユーザー接続スキーマに printer 出力系（autoPdfDir/autoPrint/pdfFontPath）を含めない。
  zod strict（`.strict()`）で未知キーを拒否し、API 経由でこれらを注入されても弾く。
- **passwordEnv 分離 → 暗号化ストア**: パスワード実値は AES-256-GCM 暗号文としてのみ保存。復号は
  `resolveConnectOptions` 内（サーバー内）だけで行い、暗号文も平文も API から返さない。他 owner のレコードは
  `assertOwner` で復号前に拒否＝他ユーザーのシークレットに到達不可（C2）。
- **鍵は .env**: `AS400_SECRET_KEY` を `start.sh` の `--env-file=.env` 経由で供給（既存機構、dotenv 依存なし）。

## エラー処理 / 異常系
- master key 不正（長さ違い）: 起動時に明示エラーで停止（黙って弱い鍵にしない）。
- master key 未設定: 起動は継続。パスワード保存 API は 400（`secret key not configured`）。既存 `secretEnc` は復号
  できず、その接続は自動サインオンなしで開く（signon 画面へ）。
- 復号失敗（鍵ローテーション等で不整合）: resolve は password 無しで続行し、監査ログに warn。レコードは壊さない。
- owner 不一致: 403 FORBIDDEN。存在しない id: 404。zod 検証失敗（printer フィールド混入・型不正）: 400。

## 受け入れ基準との対応
- 別端末で同一設定が見える → サーバー保存＋`GET /api/connections`（owner スコープ）。
- 認証オフ=全件 / オン=自分のみ → `listForUser` と `assertOwner`。
- printer 信頼フィールド不在 → zod strict スキーマ（型・API 双方で拒否）。
- パスワード平文をサーバーに保存しない → `secretEnc`（AES-256-GCM）のみ、API 露出は `hasSecret`。
- 自分の secret のみ参照 → `resolveConnectOptions` 前の `assertOwner`。
- profiles.json は読み取り専用で存続 → 変更なし（`/api/profiles`）。
- localStorage から接続読み書きが消える → `settings.ts` の接続 CRUD を `stores/connections.ts`（API）へ置換。

## design への申し送り（複雑度自己評価）
- 複数コンポーネント横断（server 新規3ファイル＋web-ui＋型＋ws/mcp 経路）・暗号スキーム/鍵管理・データモデル新設に
  当たるため、**design（詳細設計）を挟むことを推奨**。design で詰める点:
  - `secretEnc` を接続レコード同居にするか別シークレットストアに分けるか（責務分離 vs 単純さ）。
  - 鍵ローテーション運用（再暗号化 or 失効再入力）の最小方針。
  - `connection` 参照を `WsClientMessage` にどう型追加するか（profile との排他）。
  - 認証オフ時の owner 無しレコードの共有可視性と削除権限の最終確認。
