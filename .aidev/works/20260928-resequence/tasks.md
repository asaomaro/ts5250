# タスク: 再順序付け

## 実装方針
読み取り → 鎖 → 応答 → 断り。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 再順序付けの無い画面（ほぼすべて）を変えない

## テスト方針
- 単体・mutation・実機（DSM の RESEQ）

## タスク
- [x] T1: SOH と FCW 0x80nn を読み、リセットする
      対象: `packages/tn5250/src/screen/buffer.ts` `setHeaderData`・`clearFormatTable` ほか・`packages/tn5250/src/protocol/wtd-applier.ts` `applySf`
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: `readMdtFields`・`readInputFields` と応答
      対象: `packages/tn5250/src/screen/buffer.ts`・`packages/tn5250/src/protocol/read-response.ts`
      依存: T1
      AC: AC1, AC2
- [x] T3: カーソル送りの欄を断る
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `fieldAddFailure`
      依存: T1
      AC: AC3
- [x] T4: 実機スクリプト・DSM・プローブ
      対象: `scripts/verify-resequence.mjs`・`scripts/host-src/dscmd.c`・`scripts/acs-probe/resequence.txt`
      依存: T2
      AC: AC1
