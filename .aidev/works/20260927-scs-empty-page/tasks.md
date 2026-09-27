# タスク: 空ページ

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 画面の側（SpoolPane）の「ページが無い」判定は FF だけの帳票で白紙 1 枚になる（ACS と同じ）

## テスト方針
- 単体・変異・描画

## タスク
- [x] T1: FF で空ページを出す・単体テスト
      対象: `packages/scs/src/scs.ts`・`packages/scs/test/scs.test.ts` / 根拠: research A1
      依存: なし
      AC: AC1
