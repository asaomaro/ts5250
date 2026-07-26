# タスク: フラグレコードは応答を待たない

- [x] T1: `sendAid` にフラグキー（Attn / SysReq）の即解決分岐を入れ、`FLAG_KEY_TIMEOUT_MS` を削除
- [x] T2: `packages/core/src/index.ts` の公開 API から `FLAG_KEY_TIMEOUT_MS` を外す（依存: T1）
- [x] T3: `session.test.ts` を「待たない・ロックしない」検証へ差し替え（依存: T1）
- [x] T4: `docs/PROTOCOL.md` 6.2 に「応答を待たない」を明記（依存: T1）
- [x] T5: 全テスト・`npm run build`・`npm run build -w @as400web/web-ui` の通過（依存: T1〜T3）
- [x] T6: 実機で 1 回目（窓が出る）／2 回目（何も起きない）を確認（依存: T5）
