# タスク: ホストサーバー接続基盤と signon 認証

- [x] T1: `hostserver/datastream.ts` — 20バイトヘッダー＋LL/CP の組み立て・解析。単体テスト付き
- [x] T2: `hostserver/credentials.ts` — ユーザーID/パスワードのバイト化3種（CCSID 37 / UTF-16BE 20バイト / UTF-16BE 素）。変換不能は `CONFIG_ERROR`。単体テスト付き
- [x] T3: `hostserver/password.ts` — SHA 経路のパスワード置換値。固定ベクタの単体テスト付き（依存: T2）
- [x] T4: `hostserver/return-codes.ts` — 戻りコードの分類とメッセージ。上位16bit レンジ判定を含む。単体テスト付き
- [x] T5: `hostserver/port-mapper.ts` — 449 でサービス名→ポート解決。偽サーバーでの単体テスト付き
- [x] T6: `hostserver/signon.ts` — 交換属性→認証のシーケンス配線。CP `0x1105` のトレースマスクを含む（依存: T1,T3,T4）
- [x] T7: `index.ts` に公開 API を追加、`errors.ts` に `HOST_SERVER_UNSUPPORTED` を追加（依存: T5,T6）
- [x] T8: 実機検証用の CLI スクリプトを追加（`tools/` 配下。パスワードは環境変数からのみ）（依存: T7）
- [x] T9: PUB400 で実機確認 — TLS(9476)/平文(8476) の認証成功、ポートマッパー解決、トレースにパスワードが出ないこと（依存: T8）
