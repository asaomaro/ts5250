# タスク: 挿入モードが画面をまたいで残る

## 実装方針
既存の `watch(snapshot, …)` に 1 行足す。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- **監視を増やさない**（既存へ合流）。増やすと初期化の契機が散る。
- テストは `ScreenGrid` の `insertMode` prop を見る（親の ref は外から触れない）。

## テスト方針
- EmulatorPane を mount → 挿入モードにする → 新しいスナップショットを流す → prop が false。
- **行を外して落ちることを確かめる**（条項 `verify-by-mutation`）。

## タスク
- [x] T1: 既存の `watch(snapshot, …)` に `insertMode.value = false` と出所コメントを足す。
      対象: `packages/web-ui/src/components/EmulatorPane.vue:256`
      依存: なし
      AC: AC1, AC3
- [x] T2: 画面が変わると上書きへ戻ることをテストで固定する。
      対象: `packages/web-ui/test/insert-mode-reset-per-screen.test.ts`（新規）
      依存: T1
      AC: AC1
- [x] T3: mutation で担保を確かめる（行を外すと落ちる）。
      対象: `packages/web-ui/src/components/EmulatorPane.vue`（一時的に外す）
      依存: T2
      AC: AC2, AC4
