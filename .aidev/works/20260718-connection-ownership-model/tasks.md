# タスク: 接続設定の所有モデルと種別の整理

## 1. server: 種別の明示・固定・printer gate
- [x] T1: `profiles.ts` に `sessionType?` を明示追加＋`effectiveType`（導出併用）。`PublicProfile.sessionType`=effectiveType
- [x] T2: `profileInputSchema.sessionType` を新規のみ採用、更新は既存維持。`buildProfile` は display のとき printer を落とす（printer は printer 種別×editor のみ）（依存: T1）
- [x] T3: `connection-store.ts` の `update` で `sessionType` を既存維持（変更不可）
- [x] T4: server テスト（profile/connection の種別固定・display で printer 落とす・printer 露出は printer×editor）（依存: T2,T3）

## 2. server: 所有の移動（admin）
- [x] T5: `ConnectionStore.getOwned(id,user)`／`addRecord`、`ProfileStore.getRaw(name)`／`addRecord` を追加（サーバー内移送用）（依存: T1）
- [x] T6: `settings-move.ts`＝`POST /api/settings/move`（admin 限定）。personal→shared / shared→personal の秘密移送・name 衝突・passwordEnv/printer 破棄。`app.ts` に配線（依存: T5）
- [x] T7: server テスト（双方向移送・secretEnc↔passwordEnc・name 衝突 409/400・admin 限定 403・passwordEnv 破棄・printer 破棄）（依存: T6）

## 3. web-ui: 環境判定・出し分け
- [x] T8: `authStore` に enabled（`/api/me` の enabled）を持たせる／既存を確認。ConnectView に `authOff`/`isAdmin` computed
- [x] T9: カードの「共有/個人」ラベルを認証オンのときだけ表示（認証オフは非表示）（依存: T8）

## 4. web-ui: フォーム
- [x] T10: 新規フォームに種別ラジオ（エミュレーター/プリンター）。admin のみ所有ラジオ（共有/個人）。認証オフ=共有固定・一般=個人固定（依存: T8）
- [x] T11: printer 出力欄を「種別=プリンター × 所有=共有 × editor」のときだけ表示（依存: T10）
- [x] T12: 編集フォームは種別を固定（ラジオを出さず現在種別を読み取り専用表示）。エミュレーターは printer 欄なし（依存: T10）
- [x] T13: 新規作成の保存先を所有に応じて分岐（共有→/api/profiles、個人→/api/connections）（依存: T10）

## 5. web-ui: 所有変更
- [x] T14: 編集で admin が「共有にする / 個人にする」→ `/api/settings/move` を呼び、一覧を再取得（依存: T6,T12）

## 6. 検証・ドキュメント
- [x] T15: web-ui テスト（出し分け・種別固定・printer 露出条件・保存先分岐）
- [x] T16: README（所有モデル・種別固定・move・信頼境界）を更新
- [x] T17: `npm run build`（tsc）・`npm run build -w @as400web/web-ui`（vue-tsc+vite）・`npm test`・`npm run lint` 全て green
