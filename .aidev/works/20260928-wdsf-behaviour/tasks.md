# タスク: WDSF の中身の読み方

## 実装方針
parser → buffer → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存テストがスクロール・バーの 10 進を固定している（書き換える）

## テスト方針
- 単体 `wdsf-gui.test.ts`・実機 `scripts/verify-browser-wdsf-behaviour.mjs`

## タスク
- [x] T1: parser（flag3・8 バイト・2 進・0x59 のフラグ）
      対象: `packages/tn5250/src/protocol/wdsf-parser.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: buffer（`removeByPos`・`removeWindow`）
      対象: `packages/tn5250/src/screen/buffer.ts`・`wtd-applier.ts` / 根拠: research A2
      依存: T1
      AC: AC4, AC5
- [x] T3: 実機のブラウザの検証（実行は test 工程）
      対象: `scripts/verify-browser-wdsf-behaviour.mjs`（新規）
      依存: T2
      AC: AC1, AC2, AC4
