# 仕様: API トークンの自己発行と再発行による失効

## 設計方針

### 方針 1: スキーマは `tokenHashes`（配列）のまま
`tokenHash`（単数）へ変えると既存 `users.json` が読めなくなる。配列を維持し、
**発行時に配列を新しい 1 要素で置き換える**。読み込みは複数要素でも受け付ける（後方互換）。

```ts
issueToken(username: string): string {
  const token = randomBytes(24).toString("hex");
  u.tokenHashes = [hashToken(token)];  // push ではなく置き換え＝以前を失効
  return token;
}
```

### 方針 2: 自己発行は `/api/me/token`
`/api/admin/*` は `requireAdmin` 配下なので流用できない。認証ミドルウェアの保護下に
`POST /api/me/token` を置き、**`c.get("user")` のユーザー名でのみ発行**する
（パスパラメータを受けない＝他人の分を発行しようがない）。

認証オフでは発行しない（ユーザーが存在せず意味がない）→ 400。

### 方針 3: UI はヘッダーの `.whoami` から開くポップオーバー
`App.vue:179-181` に既存のユーザー名＋ログアウトがある。ここをクリックで
アカウントポップオーバーを開き、発行ボタン・警告・平文表示（コピー）を置く。
接続設定の編集画面には**置かない**（トークンはユーザーの資格情報でありコネクション単位ではない）。

## 対象範囲
| ファイル | 変更 |
|---|---|
| `packages/server/src/auth.ts` | `issueToken` を置き換え方式に |
| `packages/server/src/app.ts` | `POST /api/me/token` |
| `packages/web-ui/src/components/AccountPopover.vue` | **新規** |
| `packages/web-ui/src/App.vue` | `.whoami` から開く |
| `packages/server/test/auth-token.test.ts` | **新規** |
| `README.md` | トークン発行と MCP クライアント設定 |

## インターフェース
`POST /api/me/token` → `201 { "token": "<平文・1 回のみ>" }` / 未認証は 401 / 認証オフは 400。

## 振る舞い
- 発行のたびに `users.json` を原子的保存（`save()`）。
- 平文はサーバーに保持しない。UI 側も再表示しない（閉じたら二度と見えない）。
- 発行状態は `/api/me` の応答に `hasToken` を足して判定する。

## 受け入れ基準との対応
| 完了条件 | 満たし方 |
|---|---|
| 再発行で以前が失効 | 置き換え実装 ＋ `findByToken` が旧トークンで undefined を返すテスト |
| 一般ユーザーが自己発行 | `/api/me/token` のテスト |
| 未認証は不可 | 認証ミドルウェアの保護下 ＋ テスト |
| ハッシュのみ保存 | `users.json` を読んで平文が無いことを確認 |
| 既存ファイル互換 | 複数要素の `tokenHashes` を読み、発行後 1 本になるテスト |
| UI 警告・状態 | コンポーネントテスト |
