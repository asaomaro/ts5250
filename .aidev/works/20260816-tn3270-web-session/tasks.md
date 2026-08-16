# タスク

- [ ] T1: `packages/server` の依存に `@ts5250/tn3270` を足す（package.json / tsconfig references）
- [ ] T2: `ws-messages.ts` に `terminal?: "5250" | "3270"` と `model?: 2 | 5` を足す
- [ ] T3: `tn3270-adapt.ts`——3270 snapshot → `ScreenSnapshot` 変換
- [ ] T4: `tn3270-adapt.ts`——WS キー名 → 3270 `AidKey` 写像（使えないキーは拒否）
- [ ] T5: `tn3270-adapt.ts`——`WsKeyField[]` を `setCursor`＋`type` に落とす
- [ ] T6: `tn3270-manager.ts`——open / get / close / 画面購読
- [ ] T7: `ws-handler.ts`——`onOpen` を `terminal` で振り分け、3270 の `opened` を返す
- [ ] T8: `ws-handler.ts`——`onKey` を 3270 に振り分け、`key-done` を返す
- [ ] T9: `ws-handler.ts`——5250 専用メッセージは 3270 セッションで拒否する
- [ ] T10: web-ui——接続フォームに端末タイプ／モデル、`open` に載せる
- [ ] T11: テスト——`mini3270` 相手に open → screen → key の通し
- [ ] T12: テスト——変換・キー写像の単体
- [ ] T13: 既存の 5250 テストが全部緑
