# タスク: 表示セッションの keepAlive

## 実装方針
トランスポート → セッション → 設定 → README。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既定を変えるので、無通信の接続を落とす環境の表示セッションは `keepAlive: true` が要る（README に明記）

## テスト方針
- 単体（`setKeepAlive` の呼び出しを見る）・変異

## タスク
- [x] T1: `TcpConnectOptions.keepAlive`（既定 true）と、`Session5250` の `keepAlive`（既定 false）
      対象: `packages/tn5250/src/transport/tcp.ts` `packages/tn5250/src/session/session.ts`
      依存: なし
      AC: AC1
- [x] T2: セッション設定 `keepAlive`（スキーマ・解決・`OpenOptions`）
      対象: `packages/server/src/config-types.ts` `packages/server/src/config-resolver.ts` `packages/server/src/session-manager.ts`
      依存: T1
      AC: AC2
- [x] T3: 単体テスト
      対象: `packages/tn5250/test/tcp-keepalive.test.ts`（新規）`packages/server/test/ws-lifetime.test.ts`
      依存: T2
      AC: AC1, AC2
- [x] T4: README
      対象: `README.md`
      依存: T2
      AC: AC2
