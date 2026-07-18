# レビュー: サーバー設定を admin 限定にする

## ラウンド 1

### 観点別チェック

**要件適合**
- 一般ユーザー: 一覧が空配列 / `profile` 解決・出力設定解決が FORBIDDEN。テスト 9 件で確認。
- admin・認証オフ: 従来どおり（既存 139 テストが通ることで担保）。

**認可設計（最重点）**
- `assertProfileAccess` は `auth.ts` に 1 箇所のみ定義。`ProfileStore` から 2 箇所（接続解決・出力解決）で呼ぶ。
- 呼び出し元（ws-handler / mcp-tools）に role 判定は無い（grep で確認）。
- **user 引数を必須にした**ことで、7 経路すべてを tsc が強制。実際に最初の実装では `user?` にしており、
  mcp-tools の 4 箇所が**エラーにならず fail-open**していた。必須化して全件検出できた。

**obscurity に頼っていないか**
- 存在しない profile 名でも一般ユーザーには FORBIDDEN（`assertProfileAccess` が lookup 前に走る）。
  存在の有無が漏れないことをテストで固定。

### 指摘と対応

- [should] `listForUser` が `user.role !== "admin"` と独自判定しており、認可規則が
  `assertProfileAccess` と**二重管理**になっていた → `assertProfileAccess` を try/catch する形に修正。**対応済**。
- [nit] `app.ts` のコメントに「共有プロファイル」表記が残存（#54 の表記変更漏れ）→ 「サーバー設定」へ修正。**対応済**。
- [nit] WS / MCP の**経路単位の結合テストは追加していない**。理由: MCP ツール層に既存のテストハーネスが無く、
  スキーマ 1 経路のために新設するのは不釣り合い。担保は (a) 認可がストア側の単一点にあること、
  (b) user 引数が必須で tsc が全経路を強制すること、の 2 点。**未対応（意図的）**。

### 判定

must=0 / should=1（対応済） / nit=2（1 件対応済・1 件は意図的に未対応）。deliver へ進む。
