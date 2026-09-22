# タスク: 符号付き＋RZ の埋め字

## テスト方針
- 純関数の単体（`field-adjust.test.ts`・`field-sign-dup.test.ts`）。mutation。実機は既存の実測（F2）。

## タスク
- [x] T1: `applyAdjust` の変更と、旧い規則を固定していたテストの書き換え。
      対象: `packages/web-ui/src/composables/fieldEdit.ts` `applyAdjust` `packages/web-ui/test/field-adjust.test.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2, AC3
- [x] T2: Field−・Field+ のテストと mutation。
      対象: `packages/web-ui/test/field-sign-dup.test.ts`
      依存: T1
      AC: AC1, AC3
