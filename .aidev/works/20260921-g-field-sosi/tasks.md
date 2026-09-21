# タスク: G 欄の SO/SI

## テスト方針
- 実機の WTD の生バイトをそのまま使う core の単体、ScreenGrid を通す web-ui の単体。mutation。実機は変更前後に当 PJ と ACS のコアの両方で確かめた。

## タスク
- [x] T1: core の受信（WEA5・G の欄の中）と送信（G の SO/SI 無し・欄長）。
      対象: `packages/tn5250/src/protocol/wtd-applier.ts` `packages/tn5250/src/protocol/read-response.ts` `packages/tn5250/src/screen/buffer.ts` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: web-ui の G の予算・列ビュー・詰め物・値の落とし方・MF。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` `packages/web-ui/src/composables/fieldValidate.ts` `packages/web-ui/src/composables/mandatoryCheck.ts` / 根拠: research A2
      依存: T1
      AC: AC3, AC4
- [x] T3: テストと mutation、実機の測定の記録（試験画面・診断・手順）。
      対象: `packages/tn5250/test/dbcs-pure-field.test.ts` `packages/web-ui/test/dbcs-pure-field.test.ts` `scripts/build-gtest.mjs` `scripts/diag-gfield.mjs` `scripts/acs-probe/g-field.txt`
      依存: T1, T2
      AC: AC1, AC2, AC3, AC4, AC5
