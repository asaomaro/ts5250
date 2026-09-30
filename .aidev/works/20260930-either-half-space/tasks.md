# タスク: 半角の状態の E 欄の空きと空白

## 実装方針
測る（SPACETY・SPACETY2）→ web-ui → core → テスト・実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- E の状態判定（`eitherDbcsOn`）の呼び出しが増える。既存の E の実機スクリプトで回帰を確かめる

## テスト方針
- 単体・変異・実機のブラウザ（f2）と既存の実機スクリプトの回帰

## タスク
- [x] T1: 半角の E・open の E・通常の欄の末尾の空白を測る
      対象: `scripts/acs-probe/space-typed.txt` `scripts/acs-probe/space-typed-2.txt`
      依存: なし
      AC: AC1
- [x] T2: web-ui と core の値の空き
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `eitherHalf` `packages/web-ui/src/composables/mandatoryCheck.ts` `packages/tn5250/src/screen/buffer.ts`
      依存: T1
      AC: AC1, AC2
- [x] T3: テスト・変異・実機の検証
      対象: `packages/web-ui/test/o-field-nul.test.ts` `packages/tn5250/test/o-field-send.test.ts` `scripts/verify-browser-space-typed.mjs`
      依存: T2
      AC: AC1, AC2, AC3
