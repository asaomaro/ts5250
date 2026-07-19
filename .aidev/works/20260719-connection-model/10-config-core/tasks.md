# タスク: 10-config-core

- [x] T1: `config-types.ts` — `systemSchema` / `serverSessionSchema` / `personalSessionSchema` を定義。
      **個人側に `printer` を含めない**（信頼境界 1 層目）。ファイル全体のスキーマも定義
- [x] T2: `config-migrate.ts` — 旧形式（`profiles` / `connections` 配列）→ 新形式の純関数。
      束ね規則 1/2/3、命名規則、`passwordEnc` の非再暗号化、`lastConnectedAt` の破棄（依存: T1）
- [x] T3: `config-migrate` のテスト — 規則 1/2/3 の各ケース、命名、暗号の持ち回り、
      **実データ相当が 1 システム + 3 セッションになること**（依存: T2）
- [x] T4: `config-store.ts` — 読み込み（新旧判定・移行呼び出し）、CRUD、所有者チェック、
      tmp→rename 書き出し。**`dirty` を持たず、保存は明示呼び出しのみ**（依存: T1, T2）
- [x] T5: `config-store` のテスト — 所有者チェック、個人設定への `printer` 投入が弾かれること、
      読み込みだけでは書き出さないこと（依存: T4）
- [x] T6: `config-resolver.ts` — `resolve({system?, session?}, user, warn)`。接頭辞でストアを選択。
      `warn` は必須引数。`ccsid` はセッション優先。printer 出力はサーバー由来のみ（依存: T4）
- [x] T7: `config-resolver` のテスト — 解決 5 ケース、ファイル外参照の `CONFIG_ERROR`、
      復号失敗時の `warn` と継続（依存: T6）
- [x] T8: 旧ストアに `@deprecated` を付す。**削除はしない**（参照の付け替えは `20` のため。
      この slice を単独でビルド可能に保つ）（依存: T6）
- [x] T9: `pnpm lint` / `pnpm build` / `pnpm test` を通す（依存: T1-T8）
