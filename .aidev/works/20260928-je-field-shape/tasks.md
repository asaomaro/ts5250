# タスク: J・全角の E の欄の送るバイト列を ACS と同じにする

## 実装方針
コアのセル化（NUL の組）→ 画面の側の形と送る値 → 持ち回り → 実機で ACS と突き合わせる。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- `edits` の意味を変えない（論理値のまま）

## テスト方針
- 単体（web-ui・tn5250）と、実機のブラウザでの突き合わせ（`scripts/verify-browser-je-field.mjs`）

## タスク
- [x] T1: コアの `setFieldCells` で並びの中の NUL を空のセルにする
      対象: `packages/tn5250/src/screen/buffer.ts` `setFieldCells` / 根拠: research A3
      依存: なし
      AC: AC1
- [x] T2: 画面の側の欄の形（`jeShapeOf`・`jeShapeOverride`）と送る値（`jeExplicit`・`jeMeta`）、消去・切り替えでの形の変化
      対象: `packages/web-ui/src/components/ScreenGrid.vue` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T3: 送る値の持ち回り（`SessionState.wire`・`onEdit`・送信で `wire` を優先）
      対象: `packages/web-ui/src/stores/sessions.ts` `EmulatorPane.vue` `session-controller.ts` / 根拠: research A2
      依存: T2
      AC: AC1
- [x] T4: 単体テスト（形ごと・消去・切り替え・新しい画面・コアのバイト列）
      対象: `packages/web-ui/test/je-field-shape.test.ts` `packages/tn5250/test/je-field-send.test.ts`（新規）
      依存: T1, T3
      AC: AC1
- [x] T5: 実機の検証（DSM の JEEDIT・ACS の probe・ブラウザの突き合わせ）
      対象: `scripts/host-src/dscmd.c` `scripts/acs-probe/je-field-edit.txt` `scripts/verify-browser-je-field.mjs`
      依存: T3
      AC: AC2
