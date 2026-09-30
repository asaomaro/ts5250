# タスク: 語送り

## 実装方針
core（印・値）→ 純関数の移植 → 編集モデル → ScreenGrid のフック → 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 貼り付け・IME 確定は語送りを掛けない（未測定。台帳に残す）
- 値の途中の NUL はセンチネルで運ぶ（語送りの欄だけ）

## テスト方針
- 単体（W1〜W8 の再現・分岐ごとの端）、コンポーネント、変異、実機のブラウザ

## タスク
- [x] T1: core: 印（`wordWrap`）・値（途中の NUL）・NUL センチネルを空きのセルに
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `packages/tn5250/src/screen/buffer.ts` `packages/tn5250/src/screen/types.ts`
      依存: なし
      AC: AC3
- [x] T2: `wordWrap.ts`（ACS の手順の移植）と `EditState.pad`
      対象: `packages/web-ui/src/composables/wordWrap.ts`（新規）`packages/web-ui/src/composables/fieldEdit.ts`
      依存: なし
      AC: AC1
- [x] T3: ScreenGrid のフックと語送りの欄の編集モデル
      対象: `packages/web-ui/src/components/ScreenGrid.vue`
      依存: T1, T2
      AC: AC2
- [x] T4: 単体・コンポーネントのテストと変異
      対象: `packages/tn5250/test/word-wrap-field.test.ts` `packages/web-ui/test/word-wrap.test.ts` `packages/web-ui/test/word-wrap-field-edit.test.ts`
      依存: T3
      AC: AC1, AC2, AC3
- [x] T5: 実機のブラウザ検証（W1〜W8）と ACS のプローブの記録
      対象: `scripts/verify-browser-word-wrap.mjs`（新規）`scripts/acs-probe/word-wrap.txt` `scripts/host-src/dscmd.c`
      依存: T3
      AC: AC4
