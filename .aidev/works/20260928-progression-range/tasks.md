# タスク: カーソル送りの番号が並びの外なら動かない

## 実装方針
core の判定 → HLLAPI の Tab → ペイン → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- Field Exit の行き先は実測していない（原典の手順で動かさない）

## テスト方針
- 単体 `tab-backtab-position.test.ts`・`cursor-progression-nav.test.ts`・実機 `scripts/verify-browser-progression-range.mjs`

## タスク
- [x] T1: `progressionStuck` と `tabPosition`
      対象: `packages/tn5250/src/screen/search.ts:134` / 根拠: research A1
      依存: なし
      AC: AC1, AC3
- [x] T2: ペインの Tab・満杯の自動送り
      対象: `packages/web-ui/src/components/EmulatorPane.vue` `focusByOffset`・`onFieldFull` / 根拠: research A2
      依存: T1
      AC: AC1, AC2
- [x] T3: 実機のブラウザの検証（実行は test 工程）
      対象: `scripts/verify-browser-progression-range.mjs`（新規）
      依存: T2
      AC: AC1, AC2
