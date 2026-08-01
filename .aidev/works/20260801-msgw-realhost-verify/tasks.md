# タスク: MSGW の実機検証

- [x] T1: MSGW を誘発する道を探す（自動構成 `8940` → 自作 `8903` → **既存装置 `PRT_TEST` を借りる**）
- [x] T2: `scripts/research-msgw.mjs` で MSGW を作り、`retrieveMessage` /
      `answerMessage` を通す（依存: T1）
- [x] T3: 見つかった欠陥を直す——`decodeNpString` の CCSID 37 決め打ちを
      サーバー CCSID に（依存: T2）
- [x] T4: 単体テスト 4 ケース（CCSID を渡す / 37 だと化ける / 英数字はどちらでも / 既定は 37）（依存: T3）
- [x] T5: 実機で再実行し 8 項目すべて PASS を確認（依存: T4）
- [x] T6: `npm run build` / `npm run lint` / `npm test` ＋ **実機の残留 0 を確認**（依存: T1〜T5）
