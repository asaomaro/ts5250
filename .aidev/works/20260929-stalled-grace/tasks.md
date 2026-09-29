# タスク: 心拍で切れたときの猶予

## 実装方針
マネージャ → ws-handler → CLI → README。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 閉じたタブの保持は延ばさない（US2）

## テスト方針
- 単体（マネージャ・ws-handler）・変異・実機

## タスク
- [x] T1: `stalledGraceMs`・`graceFor`・`holdForReconnect(id, stalled)`・`disposition` の `stalled`
      対象: `packages/server/src/session-manager.ts`
      依存: なし
      AC: AC1
- [x] T2: 心拍の死判定で `stalled: true` を渡す
      対象: `packages/server/src/ws-handler.ts`
      依存: T1
      AC: AC1
- [x] T3: `--stalled-grace` の解釈と受け渡し
      対象: `packages/server/src/main.ts`
      依存: T1
      AC: AC1
- [x] T4: 単体テスト
      対象: `packages/server/test/session-reconnect-grace.test.ts` `packages/server/test/ws-lifetime.test.ts` `packages/server/test/reconnect-grace-option.test.ts`
      依存: T2, T3
      AC: AC1
- [x] T5: README の起動オプション表と寿命の注記
      対象: `README.md`
      依存: T3
      AC: AC1
- [x] T6: 実機の比較（既定のサーバーで心拍に返事しない接続・閉じた接続）
      対象: なし（実行のみ）
      依存: T2
      AC: AC2
