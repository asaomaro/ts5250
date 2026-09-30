# タスク: ホストサーバーの keepAlive

## 実装方針
トランスポート → 接続クラス → サーバーの受け渡し → 設定の解決 → README。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既定を変えるので、無通信の接続を落とす環境の常駐監視は `keepAlive: true` が要る（README に明記）
- signon の内部の短い接続は対象外

## テスト方針
- 単体（実ソケットの `setKeepAlive`・接続クラスの受け渡しは signon と開く関数をモック）と変異

## タスク
- [x] T1: `host-connection`・`ddm-transport` の `keepAlive`（既定 false）
      対象: `packages/hostserver/src/transport/host-connection.ts` `packages/hostserver/src/transport/ddm-transport.ts`
      依存: なし
      AC: AC1
- [x] T2: 6 種の接続クラスの `keepAlive`
      対象: `packages/hostserver/src/command/command-connection.ts` `db/db-connection.ts` `ifs/ifs-connection.ts` `spool/netprint-connection.ts` `dtaq/dtaq-connection.ts` `ddm/ddm-connection.ts`
      依存: T1
      AC: AC1
- [x] T3: サーバーの受け渡しと解決（種別を問わず）
      対象: `packages/server/src/host-connect.ts` `packages/server/src/config-resolver.ts` `packages/server/src/config-types.ts`
      依存: T2
      AC: AC2
- [x] T4: 単体テスト
      対象: `packages/hostserver/test/keepalive.test.ts`（新規）`packages/server/test/host-keepalive.test.ts`（新規）`packages/server/test/ws-lifetime.test.ts`
      依存: T3
      AC: AC1, AC2
- [x] T5: README
      対象: `README.md`
      依存: T3
      AC: AC2
