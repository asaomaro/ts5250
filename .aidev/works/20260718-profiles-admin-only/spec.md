# 仕様: サーバー設定を一般ユーザーから隠す（admin 限定）

## 概要

認証オンのとき、サーバー設定（`profiles.json`）を **admin 専用**にする。
一般ユーザーからは一覧に出さず、`profile` 名を指定した接続・サインオン・出力設定解決も拒否する。

## 設計方針

### 方針 1: `assertOwner` に倣い `assertProfileAccess(user)` を新設する

`auth.ts:219` の `assertOwner` と同じ形の**単一の認可関数**を `auth.ts` に置く。

```ts
/** サーバー設定（profiles）へのアクセス可否。認証オフ=全通過 / admin=許可 / 一般=FORBIDDEN */
export function assertProfileAccess(user: AuthUser | undefined): void {
  if (!user) return;                  // 認証 OFF
  if (user.role === "admin") return;  // admin
  throw new Tn5250Error("FORBIDDEN", "forbidden: server settings are admin only");
}
```

所有者比較が無いだけで `assertOwner` と同じ構造。**認証オフと admin の挙動は不変**。

### 方針 2: 認可は ProfileStore 側で行う（呼び出し元に任せない）

6 箇所の呼び出し元それぞれで判定すると、経路追加時に漏れる。
`ProfileStore` のメソッドが `user` を受け取り、内部で `assertProfileAccess` を呼ぶ
（`ConnectionStore.resolveConnectOptions(id, user)` と同じ設計）。

**シグネチャ変更（破壊的・内部 API）**

| メソッド | 変更前 | 変更後 |
|---|---|---|
| `resolveConnectOptions` | `(name, warn?)` | `(name, user?, warn?)` |
| `resolvePrinterOutput` | `(name)` | `(name, user?)` |
| `listPublic` | `(opts?)` | `(opts?)` ＋ **`listForUser(user, opts?)` を新設** |

`listPublic` は既存の内部利用（`profiles.ts:284` の `get` 相当）があるため**残し**、
API 応答用に `listForUser(user, opts)` を新設して「一般ユーザーには空配列」を返す。
（`listPublic` を直接変えると内部の名前解決まで壊れる）

### 方針 3: 一般ユーザーには「空リスト」を返す（403 にしない）

`GET /api/profiles` は 200＋`{ profiles: [], editable: false }` を返す。
403 にすると UI 側でエラー表示が必要になり、「存在しないものとして扱う」という意図とも合わない。
一方 **`profile` を名指しした操作は 403（FORBIDDEN）** にする（存在の有無を推測させない）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/auth.ts` | `assertProfileAccess` を追加 |
| `packages/server/src/profiles.ts` | `resolveConnectOptions` / `resolvePrinterOutput` に `user`、`listForUser` を新設 |
| `packages/server/src/app.ts` | `GET /api/profiles` を `listForUser` に切替 |
| `packages/server/src/ws-handler.ts` | 3 箇所に `this.user` を渡す（`:85` open / `:127` printer open / `:135` output） |
| `packages/server/src/mcp-tools.ts` | 4 箇所に `user` を渡す（`:211` open_session / `:234` signon / `:326` open_printer / `:343` output） |
| `README.md` / `AGENTS.md` | 可視範囲の表を更新 |

**触らない**: `canEditProfiles`（編集ゲートは既に admin 限定で正しい）、`connectionInputSchema.strict()`、
`ConnectionStore`（個人接続の可視範囲は現状維持）。

## 振る舞いの詳細

| | 一覧 | `profile` 指定の接続 | `signon`(profile) | 編集 |
|---|---|---|---|---|
| 認証オフ | 全件 | 可 | 可 | 可 |
| admin | 全件 | 可 | 可 | 可 |
| 一般ユーザー | **空配列** | **403** | **403** | 不可（現状どおり） |

- 個人接続（`connection` 指定）と `host` 直指定は**影響を受けない**。
- 一般ユーザーが profile 名を推測しても `assertProfileAccess` で弾かれる（obscurity に頼らない）。

## エラー処理 / 異常系

- WS: `FORBIDDEN` は既存のエラー整形に載る（`ws_open` の監査ログにも残る）。
- MCP: `errorResult` が `FORBIDDEN: forbidden: server settings are admin only` を返す。
- 存在しない profile 名は従来どおり `SESSION_NOT_FOUND`。ただし**一般ユーザーは到達前に FORBIDDEN** になるため、
  存在の有無は漏れない。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 一般ユーザーに空リスト | `listForUser` ＋ app.ts 切替。テストで確認 |
| `profile` 接続が FORBIDDEN（WS/MCP） | ストア側で `assertProfileAccess`。各経路のテスト |
| `signon`(profile) が FORBIDDEN | `mcp-tools.ts:234` に user を渡す |
| admin / 認証オフが従来どおり | 回帰テストで担保 |
| 認可が単一関数に集約 | `assertProfileAccess` のみ。呼び出し元に条件分岐を書かない |
| ドキュメント更新 | README の MCP 表と AGENTS の権限表 |
