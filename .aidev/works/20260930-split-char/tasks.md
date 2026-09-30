# タスク: 割れた全角の半分

## 実装方針
値の表し方 → core（セル・検証・長さ）→ web-ui（詰め直し・往復・読み戻し）→ 実機。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 実機のブラウザの最初の走行で、検証（FIELD_TYPE）と桁数の検査（FIELD_OVERFLOW）が割れた半分を弾いた。値を運ぶ全ての検査を通すことを単体（セッション経由）で固定する

## テスト方針
- 単体（セル・送信・検証・セッション）・ScreenGrid・変異・実機

## タスク
- [x] T1: 値の表し方と core（セル・検証・桁数の検査）
      対象: `packages/tn5250/src/screen/attr-sentinel.ts` `buffer.ts` `field-validate.ts` `packages/tn5250/src/session/session.ts`
      依存: なし
      AC: AC2
- [x] T2: web-ui（詰め直し・値⇔セル・読み戻し・normalizeO）
      対象: `packages/web-ui/src/composables/oChainCells.ts` `oFieldCells.ts` `fieldValidate.ts` `packages/web-ui/src/components/ScreenGrid.vue`
      依存: T1
      AC: AC1, AC2
- [x] T3: テスト・変異・実機
      対象: `packages/tn5250/test/split-char-session.test.ts`（新規）`o-chain-send.test.ts` `packages/web-ui/test/o-chain-cells.test.ts` `o-chain-edit.test.ts` `scripts/verify-browser-cont-o-last-lead.mjs`（新規）
      依存: T2
      AC: AC1, AC2
