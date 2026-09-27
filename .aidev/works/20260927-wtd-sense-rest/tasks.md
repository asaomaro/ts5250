# タスク: WTD の中の否定応答・受理の残り

## 実装方針
下の `依存:` に従う。

## テスト方針
- 単体（ACS の実測の画面・センス）・変異・実機（`scripts/verify-wtd-order-sense.mjs` の新しい 8 モードと既存の回帰）

## タスク
- [x] T1: SBA 1,0 と FFW
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` SBA・`applySf` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: 画面の末尾を越える TD
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` TD / 根拠: research A1
      依存: なし
      AC: AC2
- [x] T3: 欄の追加の失敗と属性の検査
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `fieldAddFailure`・`packages/tn5250/src/screen/buffer.ts` / 根拠: research A1, A2
      依存: T1
      AC: AC3
- [x] T4: DSM・検証スクリプト・片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/verify-wtd-order-sense.mjs`
      依存: T1, T2, T3
      AC: AC1, AC2, AC3, AC4
