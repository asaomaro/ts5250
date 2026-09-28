# タスク: 透過の欄

## 実装方針
FCW の読み取り → 欄の印 → 送信の 2 つの形。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 透過でない欄の送信を変えない

## テスト方針
- 単体・mutation・実機（DSM の TRANSP）

## タスク
- [x] T1: FCW 0x84xx を読み、欄に `transparent` を持つ
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `applySf`・`packages/tn5250/src/screen/buffer.ts` `addField`
      依存: なし
      AC: AC1, AC2
- [x] T2: READ MDT 系・READ INPUT 系の送信
      対象: `packages/tn5250/src/protocol/read-response.ts`
      依存: T1
      AC: AC1, AC2
- [x] T3: DSM の TRANSP・プローブ・実機スクリプト
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/transparent-field.txt`・`scripts/verify-transparent-field.mjs`
      依存: T2
      AC: AC1
