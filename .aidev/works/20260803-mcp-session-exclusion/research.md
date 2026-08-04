# 調査: MCP の排他

## 調査の問い

- Q1: 「見ている人が居る」をどう判定するか。既存の合図はあるか
- Q2: MCP のどこに差し込むか。書き込みの入口は何箇所か
- Q3: 予約の期限は用途別に持てるか
- Q4: `list_sessions` は何を返しているか

## 判明した事実

### F1: 在席の合図は無い。代用できそうなものは**脆い**

`ws-handler.ts` がセッションへ付けるのは 3 つ:

```ts
entry.session.on("screen", onScreen);                  // EventEmitter（複数可）
entry.onPcCommandEvent = ...                           // **単数枠・上書き**
entry.onReservationChange = ...                        // **単数枠・上書き**
this.detachScreen = () => { ...off/delete... };        // 切断で外す（:655）
```

`onReservationChange` の有無を在席判定に流用できるが、**通知フックを在席の印にするのは脆い**
——通知が要らなくなった瞬間に在席判定が壊れる。**明示的に数える**べき。

`entry.session.listenerCount("screen")` も使えるが、購読者が ws-handler だけとは限らない
（録画・監視が付く可能性）。**「ブラウザが見ているか」を直接表す数**を持つのが正しい。

### F2: MCP の書き込みの入口は **8 箇所**

`mcp-tools.ts` の `assertWritable` / `assertKeyAllowed`:

```
355  signon            922  set_fields         954  send_key（キー）
956  send_key（欄）     989  select_gui_choice  1020 submit_gui_selection
1062 run_steps（欄）    1068 run_steps（キー）
```

**共通のラッパは無い**（`server.registerTool` を個別に呼び、各ハンドラが `withAudit` を自分で巻く）。
`withAudit` も同じ形で 25 箇所に散っているので、**この repo の作法としては散らすのが普通**。

ただし 8 箇所は**足し忘れる**。`20260803-hllapi-bridge` の
`hllapi-bridge-thinness.test.ts` と同じく、**ソースを走査して固定する**のが有効。

### F3: 期限はモジュール定数で、用途別に持てない

```ts
export const RESERVATION_TTL_MS = 120_000;   // :150
... expiresAt: this.now() + RESERVATION_TTL_MS   // reserve():1111 と touchReservation():1140
```

HLLAPI（明示的に予約し、長く保つ）と MCP（自動で取り、すぐ手放す）で必要な長さが違う。
**予約そのものに期限を持たせて `touchReservation` がそれを使う**形にすれば、両立できる。

### F4: `list_sessions` は予約を返していない

返しているのは `sessionId` / `host` / `origin` / `connectedAt` / `readOnly` / `keyboardLocked`。
エージェントは「いま人が触っている」を知る手段が無く、**断られて初めて気づく**。

### F5: 締め出しの検査は既に正しい場所にある

`assertWritable` / `assertKeyAllowed` の内側（`session-manager.ts`）。
`holder` を渡さない呼び出し＝人間扱いで断られる。**MCP は既に締め出される側としては正しく動く**
（実機 E2E で確認済み: `verify-hllapi-browser.mjs` の「予約中は MCP も締め出される」）。
足りないのは**取る側**だけ。

## 影響範囲

- `packages/server/src/session-manager.ts` — 在席カウント、期限の保持
- `packages/server/src/ws-handler.ts` — 在席の付け外し（`detachScreen` に相乗り）
- `packages/server/src/mcp-tools.ts` — 8 箇所＋`list_sessions`
- **web-ui は変更なし**（`label` がそのまま出る）

## 実現性 / リスク

- **低リスク。** 予約の仕掛けは全部揃っていて、足すのは「取る側」と「在席の数」だけ
- リスクは**足し忘れ**（8 箇所）→ ソース走査の検査で固定する
- 期限の値は実測して決める（要件の未確定事項）

## spec への申し送り

- 在席は**明示的な数**にする。通知フックを流用しない
- 8 箇所は**検査で固定**する（散らすのは repo の作法だが、忘れると黙って効かなくなる）
- 期限は**予約に持たせる**（`RESERVATION_TTL_MS` は HLLAPI の既定として残す）
- `reserve_session` のようなツールは**作らない**（要件どおり）
