# タスク: 01-server

- [x] T1: `hllapi-types.ts` — 機能番号・戻り値（`HRC_*`）の定数と、要求／応答の型
- [x] T2: `hllapi-ps.ts` — 位置換算（1 起点）と PS の走査（連結・検索・欄）。**純関数**（依存: T1）
- [x] T3: `hllapi-keys.ts` — `@` ニーモニックの解析と ts5250 のキー名への写像。**純関数**（依存: T1）
- [x] T4: `hllapi.ts` — 機能番号の分岐（**既定は `rc=10`**）。接続ごとの論理カーソルを持つ（依存: T2, T3）
- [x] T5: `hllapi-routes.ts` — `POST /api/hllapi` ＋ `app.ts` に登録（依存: T4）
- [x] T6: 単体テスト（依存: T2, T3, T4）
- [x] T7: `npm run build` / `npm run lint` / `npm test` を通す（依存: T5, T6）
