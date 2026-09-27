# タスク: EA の扱い

## 実装方針
EA の処理とテスト、実機の検証。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存の EA のテスト（長さ 3）を ACS に合わせて直す。

## テスト方針
- tn5250 全体。変異: 書き始めの +1・タイプの判定・2 つ目のタイプ。

## タスク
- [x] T1: EA を属性タイプごとに処理し、書き始めを行き先の次にする
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `case ORDER.EA` / 根拠: research A1
      依存: なし
      AC: AC2
- [x] T2: 単体テスト（新規と既存の直し）
      対象: `packages/tn5250/test/wtd-order-sense.test.ts`・`packages/tn5250/test/wtd-applier.test.ts`
      依存: T1
      AC: AC2
- [x] T1b: 画面の終わりを越える文字の並びは書かずにその場で戻る（D2）
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWtd`（`runLength`・`WTD_ORDERS`）
      依存: T1
      AC: AC1, AC2
- [x] T1c: 最後の桁でちょうど終わった次は 1 行 1 桁から（EA の後を除く。D3）
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWtd`（`eaAtEnd`）
      依存: T1b
      AC: AC1, AC2
- [x] T3: 実機の試験と片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/ea-acs.txt`・`scripts/verify-ea-acs.mjs`・`scripts/README.md`
      依存: T1
      AC: AC1, AC3
