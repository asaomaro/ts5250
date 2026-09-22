# タスク: Erase Input が、中身のある全入力欄を消す

## 実装方針
ACS に合わせる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存の振る舞いを壊さない。

## テスト方針
- 振る舞いを固定し、mutation で効きを確かめる。

## タスク
- [x] T1: 原典を確認して実装する。
      対象: `packages/web-ui/src/components/ScreenGrid.vue`
      依存: なし
      AC: AC1
- [x] T2: テストを足し mutation で確かめる。
      対象: `packages/web-ui/test/`
      依存: T1
      AC: AC1, AC2
