# タスク

- [x] 1. core: `screen/types.ts` に `FieldAdjust` と `Field.adjust` / `Field.signedNumeric` を追加し、`screen/buffer.ts` の `snapshot()` で FFW から埋める（`index.ts` の型 export も）
- [x] 2. core: `screen/field-validate.ts` の数値欄判定を `value.trim()` に対して行う（前後の空白は padding として許す・埋め込み空白は従来どおり拒否）
- [x] 3. web-ui: `composables/fieldEdit.ts` に `eraseToEnd` / `rightAdjust` / `applyAdjust` / `fieldExit` を追加（原典 `tn5250_display_shift_right` の移植）
- [x] 4. web-ui: `components/ScreenGrid.vue` に `fieldExit()` / `eraseEof()` / `eraseInput()` を実装し `defineExpose` へ足す（DBCS 欄は右寄せしない）
- [x] 5. web-ui: `stores/keybindings.ts` を `local:` 対応＋`ADDED_BY_VERSION` の増分マージへ直し、既定 3 つを追加
- [x] 6. web-ui: `composables/useKeymap.ts` の `LocalAction` 拡張と `local:` 分岐、`components/EmulatorPane.vue` の `onLocal` 配線、`components/KeybindingsPanel.vue` の optgroup 追加
- [x] 7. テスト: `field-adjust.test.ts`（基準 1–4）/ core の `field-adjust-snapshot` `field-validate` 追加（基準 5・6）/ `keybindings.test.ts` 追記（基準 7・8）
- [x] 8. 検証: `scripts/verify-browser-adjust.mjs`（Playwright で実機 TESTLIB/ADJPGM を操作し、Field Exit の右寄せがホストへ届くことを確認）
- [x] 9. `README.md:335` を実装に合わせて書き直し、`.aidev/backlog/field-input.md` の済み項目を消して実測の訂正を追記

## 実装中に増えた作業（計画外・decisions.md D9）

- [x] `ScreenGrid` の欄内 keydown（SBCS / DBCS 両方）へ修飾キーガードを追加。
      Ctrl+Delete / Ctrl+Backspace が**欄内編集とローカル編集キーで二重に効く**衝突を潰した
