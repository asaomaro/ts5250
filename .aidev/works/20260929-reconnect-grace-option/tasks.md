# タスク: `--reconnect-grace`

## 実装方針
解釈 → 渡す → README。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 猶予を長くすると、戻らないタブの装置とジョブをその間ホストで掴む（READMEに明記）

## テスト方針
- 単体と実機（既定との比較）

## タスク
- [x] T1: `parseReconnectGrace`・`sessionManagerOptions`・`--reconnect-grace` の解釈
      対象: `packages/server/src/main.ts`
      依存: なし
      AC: AC1
- [x] T2: 単体テスト
      対象: `packages/server/test/reconnect-grace-option.test.ts`（新規）
      依存: T1
      AC: AC1
- [x] T3: README の起動オプション表と寿命の注記
      対象: `README.md`
      依存: T1
      AC: AC1
- [x] T4: 実機での比較（既定と `--reconnect-grace 10`）
      対象: なし（実行のみ）
      依存: T1
      AC: AC2
