# タスク

- [x] 1. `ebcdic/src/katakana.ts` — `latinChar()`（`ibm939Sbcs`）を追加。モジュール冒頭の注記を更新
- [x] 2. `ebcdic/src/index.ts` / `core/src/browser.ts` / `core/src/index.ts` — `latinChar` を再エクスポート
- [x] 3. `ebcdic/test/katakana-no-dbcs.test.ts` — T3: 到達ファイルに `tables/ibm939-sbcs.ts` を追加
      （**16 KB 上限・DBCS 非到達・`codec.ts` 非到達は据え置き**）
- [x] 4. `ebcdic/test/latin.test.ts`（新規）— T1: 全 256 バイト焼き付け（実表から採取）／T2: 2 表が鏡像
- [x] 5. `web-ui/src/stores/viewSettings.ts` — `KanaView` 3 値化・`FALLBACK.kana="auto"`・
      `VIEW_ITEMS` 3 択・`migrate()` の boolean 読み替え・`SbcsView` と `resolveSbcsView()`
- [x] 6. `web-ui/src/components/EmulatorPane.vue` — `sbcsView` を算出し `:sbcs-view` で渡す
- [x] 7. `web-ui/src/components/ScreenGrid.vue` — prop 差し替え、`recodeChar()`/`recodes()` に集約、
      `displayChar` / `copyCharOf` / `linkEnabled` / `katakanaViewActive`（→ `recodeViewActive`）を差し替え
- [x] 8. `web-ui/test/view-settings-kana.test.ts`（新規）— T4: `resolveSbcsView` 6 通り／T5: `migrate`
- [x] 9. `web-ui/test/screen-grid-sbcs-view.test.ts`（新規）— T6: host/kana/latin の描画／T7: `rawByte` 無しは不変

## 検証

- [x] 10. `npm run build`（tsc -b）
- [x] 11. `cd packages/ebcdic && npx vitest run`
- [x] 12. `cd packages/core && npx vitest run`
- [x] 13. `cd packages/web-ui && npx vitest run`
- [x] 14. `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json`
- [x] 15. `npx eslint`（変更した core/ebcdic のファイル）
- [x] 16. 旧設定 `kana: true` / `false` を localStorage に置いた状態で移行が効くこと（T5 で担保）
