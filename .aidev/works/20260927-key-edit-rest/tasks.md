# タスク: キー編集の細部の残り

## 実装方針
design のとおり。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- web-ui の CSRINPONLY と Home は実機のブラウザでは確かめていない（ACS の実測値を単体テストに固定）

## テスト方針
- 単体・変異・実機（PA・Test Request）

## タスク
- [x] T1: 文字の割当と Alt の ¢¬£（既定の版 6）
      対象: `packages/web-ui/src/stores/keybindings.ts`・`composables/useKeymap.ts`・`components/ScreenGrid.vue`・`components/KeybindingsPanel.vue`・テスト / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: J 欄がホーム位置のときの Home
      対象: `packages/web-ui/src/components/EmulatorPane.vue` の `homeKey`・`test/home-key-acs.test.ts` / 根拠: research A2
      依存: なし
      AC: AC2
- [x] T3: CSRINPONLY（core のフラグと web-ui の寄せ方）
      対象: `packages/tn5250/src/screen/buffer.ts`・`types.ts`・`packages/web-ui/src/composables/csrInputOnly.ts`・`EmulatorPane.vue` の `moveCell`・テスト / 根拠: research A2・A3
      依存: なし
      AC: AC3
- [x] T4: PA1〜3 と Test Request（core・server・web-ui）と実機の検証
      対象: `packages/tn5250/src/session/aid-keys.ts`・`session.ts`・`protocol/constants.ts`・`read-response.ts`・`packages/server/src/macro-types.ts`・`mcp-tools.ts`・`hllapi-keys.ts`・`packages/web-ui/src/session-controller.ts`・テスト・`scripts/verify-pa-test-keys.mjs` / 根拠: research A3・A4
      依存: なし
      AC: AC4
- [x] T5: DSM のモード・プローブ・README・片付け
      対象: `scripts/host-src/dscmd.c`・`scripts/acs-probe/j-field-home.txt`・`csr-input-only.txt`・`pa-keys.txt`・`scripts/README.md`
      依存: T2, T3, T4
      AC: AC2, AC3, AC4, AC5
