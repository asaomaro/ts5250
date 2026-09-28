# タスク: WDSF 0x52

## 実装方針
読み取り → 適用 → 検証。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- ほかの WDSF の扱いを変えない

## テスト方針
- 単体・mutation・実機（DSM）

## タスク
- [x] T1: 0x52 を読んで適用する
      対象: `packages/tn5250/src/protocol/wdsf-parser.ts`・`packages/tn5250/src/protocol/wtd-applier.ts`・`packages/tn5250/src/screen/buffer.ts`
      依存: なし
      AC: AC1, AC2
- [x] T2: DSM・プローブ・実機スクリプト
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/window-unrestrict.txt`・`scripts/verify-window-unrestrict.mjs`
      依存: T1
      AC: AC1, AC2
