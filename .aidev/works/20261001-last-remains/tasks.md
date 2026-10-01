# タスク: 最後の残り

## 実装方針
測る（OPENE・CONTOS・SPACETY2）→ open の E → 通常の欄 → 実機の回帰。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 通常の文字欄は全画面で使う。実機の既存スクリプト（adjust・ffw・keystroke-rules・cursor-progression ほか）で回帰を確かめる

## テスト方針
- 単体・変異・実機のブラウザ

## タスク
- [x] T1: 測定（open の E の打鍵・割れた全角の編集）
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/open-e-typing.txt` `scripts/acs-probe/cont-o-split-edit.txt`
      依存: なし
      AC: AC1, AC3
- [x] T2: open の E（送る形・欄の長さ）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `byteLen` `jeExplicit` `jeErased`
      依存: T1
      AC: AC1
- [x] T3: 通常の文字欄の空き（NUL）
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `usesNulPad` `packages/web-ui/src/composables/fieldEdit.ts` `packages/tn5250/src/screen/field-validate.ts`
      依存: T1
      AC: AC2
- [x] T4: テスト・変異・実機
      対象: `packages/web-ui/test/open-e.test.ts`（新規）`o-field-nul.test.ts` `scripts/verify-browser-open-e.mjs`（新規）`verify-browser-sbcs-space.mjs`（新規）
      依存: T2, T3
      AC: AC1, AC2, AC3
