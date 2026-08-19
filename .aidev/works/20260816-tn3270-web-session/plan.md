# 計画

## 分割しない（1 PR）

触るのは `server` の入口 3 ファイルと `web-ui` の接続フォームだけ。
**subtask に割るほど大きくない**（spec の D5 で `SessionEntry` を触らない形にしたため）。

## 順序

1. **server の土台**（他が全部これに乗る）
   - `ws-messages.ts` に `terminal` / `model` を足す
   - `tn3270-adapt.ts`（画面変換・キー写像・欄書き込み）
   - `tn3270-manager.ts`（セッションの保持）
2. **ws-handler の分岐**——`open` / `key` / `close` を `terminal` で振り分ける
3. **web-ui**——接続フォームに端末タイプとモデルを足し、`open` に載せる
4. **テスト**——`mini3270` を相手に「開く → 画面が来る → キーが届く」を通す

## 依存

`packages/server` は `@ts5250/tn3270` に依存していない。**まず package.json と tsconfig の参照を足す**
（これを忘れると型解決から落ちる）。

## 危ないところ

- **層規約**: `tn5250` と `tn3270` は**兄弟で相互参照禁止**（`dependency-direction.test.ts`）。
  変換は **server 側**に置く。`tn3270` から `tn5250` の型を import しない
- **既存の 5250 を壊さない**——`ws-handler` の共通経路（監査・readOnly・heartbeat）は
  分岐の**手前**に残す
- **web-ui の型**は `@ts5250/tn5250` の `ScreenSnapshot` のまま。**変換の質が全部**
