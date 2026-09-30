# タスク: プリンターの keepAlive

## 実装方針
セッション → 設定の解決 → open → README。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既定を変えるので、無通信の接続を落とす環境の常駐プリンターは `keepAlive: true` が要る（README に明記）

## テスト方針
- 単体（`setKeepAlive` の呼び出し）と変異

## タスク
- [x] T1: `PrinterSession` の `keepAlive`（既定 false）
      対象: `packages/tn5250/src/session/printer-session.ts`
      依存: なし
      AC: AC1
- [x] T2: 設定の解決・`printerOptsFrom`・`OpenPrinterOptions`
      対象: `packages/server/src/config-resolver.ts` `packages/server/src/ws-handler.ts` `packages/server/src/session-manager.ts` `packages/server/src/config-types.ts`
      依存: T1
      AC: AC2
- [x] T3: 単体テスト
      対象: `packages/tn5250/test/tcp-keepalive.test.ts` `packages/server/test/ws-lifetime.test.ts`
      依存: T2
      AC: AC1, AC2
- [x] T4: README・コメント
      対象: `README.md` `packages/tn5250/src/transport/tcp.ts`
      依存: T2
      AC: AC2
