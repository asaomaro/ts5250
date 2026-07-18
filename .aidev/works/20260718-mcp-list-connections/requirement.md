# 要件: MCP から接続設定を探索できるようにする（list_connections）

## 背景 / 課題
MCP ツール 17 個に**接続設定の一覧を返すものが無い**。`list_sessions` は「開いている実行中セッション」で
あって接続設定ではない。

そのためクライアント（LLM）は `profile` 名や `connection` ID を**自力で知る手段が無く**、人間が
プロンプトやクライアント設定に書くしかない。実際このセッションでも `profiles.local.json` を直接読んで
名前を得た（MCP ツールだけでは分からなかった）。

ブラウザは `GET /api/profiles` / `/api/connections` で探索できるのに、MCP だけができない非対称。

## 目的 / ゴール
**MCP クライアントが、自分に使える接続設定を列挙して選べるようにする。**

## スコープ
### 対象
- `list_connections` ツールを追加し、**サーバー設定（profile）と保存済み接続（connection）の両方**を返す。
- 各エントリに `open_session` へ渡すべき**参照方法**（`profile` 名 / `connection` ID）を含める。
- 可視範囲は既存の認可規則を**そのまま再利用**する
  （profiles＝`listForUser`＝認証オンでは admin のみ、connections＝所有者スコープ）。

### 対象外
- 接続設定の作成・編集・削除の MCP ツール化（UI/ファイル経由のまま）。
- `host` 直指定の支援。
- 認可規則そのものの変更。

## 機能要件
- 返す情報は**接続先を選ぶのに必要な最小限**にとどめる。
- **信頼設定（`printer.autoPdfDir` / `autoPrint`）と `signonUser` は返さない**。
  LLM のコンテキストに残るため、サーバー内部の値を渡さない。
- 自動サインオンの有無は真偽値でのみ示す。
- 認証オンの一般ユーザーには、サーバー設定は含まれず自分の接続のみが返る。
- 認証オフでは両方が返る。

## 完了条件 (受け入れ基準)
- [ ] `list_connections` が profile と connection の両方を、参照方法つきで返す。
- [ ] 一般ユーザーにはサーバー設定が含まれない（`listForUser` の規則どおり）。
- [ ] `printer` 設定と `signonUser` が応答に含まれない。
- [ ] 返された参照で `open_session` が成功する。
- [ ] README のツール数と一覧が更新される。
