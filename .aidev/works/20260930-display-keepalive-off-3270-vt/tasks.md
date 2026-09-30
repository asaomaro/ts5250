# タスク: 3270・VT の keepAlive

## 実装方針
トランスポート → セッション → マネージャ → open → 設定の解決。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- マネージャ（`Tn3270Manager`・`VtManager`）の受け渡しは 2 行で、開く処理が実接続を伴うため単体では直接見ていない（ws 層のテストと型で担保）

## テスト方針
- 単体（`setKeepAlive` の呼び出し）と変異

## タスク
- [x] T1: 3270・VT の `TcpConnectOptions.keepAlive` とセッションの `keepAlive`（既定 false）
      対象: `packages/tn3270/src/transport/tcp.ts` `packages/tn3270/src/session/session.ts` `packages/vt/src/transport/tcp.ts` `packages/vt/src/session/vt-session.ts`
      依存: なし
      AC: AC1
- [x] T2: マネージャ・open・設定の解決（表示のすべて）
      対象: `packages/server/src/tn3270-manager.ts` `packages/server/src/vt-manager.ts` `packages/server/src/ws-handler.ts` `packages/server/src/config-resolver.ts`
      依存: T1
      AC: AC2
- [x] T3: 単体テスト
      対象: `packages/tn3270/test/tcp-keepalive.test.ts`（新規）`packages/vt/test/tcp-keepalive.test.ts`（新規）`packages/server/test/ws-lifetime.test.ts`
      依存: T2
      AC: AC1, AC2
- [x] T4: README
      対象: `README.md`
      依存: T2
      AC: AC2
