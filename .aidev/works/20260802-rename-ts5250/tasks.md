# タスク: `@ts5250` → `@ts5250` の改名

- [x] T1: 語 `ts5250` を一括置換（`.aidev` / `node_modules` / `dist` / lock を除く）
- [x] T2: `package.json` の name 9 件 ＋ Electron の `productName` / `appId`（依存: T1）
- [x] T3: README ほかドキュメントの表記（依存: T1）
- [x] T4: `npm install` で `package-lock.json` を作り直す（依存: T2）
- [x] T5: `npm run build` / `npm run lint` / `npm test`（依存: T4）
- [x] T6: **依存の向きの検査が空振りしていない**ことを、わざと違反を入れて確認（依存: T5）
- [x] T7: `.aidev` が無変更であること・秘密走査（依存: T6）
