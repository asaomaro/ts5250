# レビュー記録

## ラウンド 1（2026-07-18）

差分全体（server 新規3ファイル＋REST/open/main 配線、web-ui ストア置換＋ConnectView、型・docs）を、
要件適合・正確性・セキュリティ・保守性の観点で点検した。

### セキュリティ（重点）
- **パスワード非露出**: `PublicConnection` は `secretEnc` を落とし `hasSecret` のみ返す。REST の POST/PUT/DELETE
  レスポンスに平文・暗号文とも含まれない（app-connections テストで `not.toContain` を固定）。→ 問題なし。
- **復号前の認可**: `resolveConnectOptions` は `assertOwner` を通した後にのみ `decrypt` する。他 owner の接続 ID を
  指定しても復号に到達しない（ws-handler / connection-store テストで FORBIDDEN を固定）。→ 問題なし。
- **信頼境界**: ユーザー接続スキーマは zod `.strict()` で printer 出力系（autoPdfDir/autoPrint/pdfFontPath）を拒否。
  API・store 双方でテスト済み。クライアント入力が `process.env` やパス書き込みに到達する経路は無い
  （方式 (b) 暗号化ストアのため env 名参照口も無い）。→ 問題なし。
- **CSRF**: Cookie は `SameSite=Lax`（既存 login 設定）。クロスサイトの POST/PUT/DELETE では Cookie が送られない。
  Bearer トークンはアンビエントでない。→ 追加の CSRF 対策は不要。
- **平文をログに出さない**: 復号失敗 warn はメッセージに接続 ID のみ、パスワードを含めない。→ 問題なし。

### 要件適合
- 認証オフ=全件 CRUD / 認証オン=自分のみ（admin 全件・無主は admin のみ）を `listForUser`＋`assertOwner` で実現、
  テストで固定。localStorage の接続 CRUD は撤去（`settings.ts` 削除）。共有 `profiles.json` は読み取り専用で存続。
  → 受け入れ基準を満たす。

### 正確性 / エッジケース
- update の password 規則（未指定=据え置き / 空=解除 / 非空=再暗号化）を実装・テスト済み。
- master key 未設定: 接続可・パスワード保存 400・既存 secretEnc は復号せず password 無しで続行。テスト済み。
- 後方互換: connections 未配線なら `/api/connections` 未登録（404）。テスト済み。

### 指摘
- [nit] `connections.json` の既定パスは CWD 依存（サーバー起動ディレクトリに生成）。README と `.gitignore` に
  記載済みで実害なし。将来 `--connections` 明示を推奨する余地あり。/ 対応: 許容（ドキュメント済み）。
- [nit] 実機 PUB400 での接続 ID 参照 open の e2e は未実施（資格情報が要るため）。単体/統合では網羅済み。
  / 対応: 許容（deliver の既知の制約に引き継ぎ）。

### 判定
must / should: 0 件。nit: 2 件（いずれも許容・ドキュメント済み）。→ review 通過。
