# タスク

原典: `Bugfix.pdf` / 書き起こし: `source-notes.md` / 仕様: `spec.md`

## 本体

- [x] 1. `core/src/screen/buffer.ts` — 修正A+D: `resize()` から `clearGui()` を外し、`clearUnit()` を
      `resize(24,80)` + `clearGui()` に単純化。両方に原典の doc コメント
- [x] 2. `core/src/screen/buffer.ts` — 修正B: `applyGridLines()` の `value1`/`value2` を
      `GRID_DEFAULT` なら 0 に倒す＋コメント
- [x] 3. `core/src/protocol/constants.ts` — 修正G-1: `ORDER.UNKNOWN_1C: 0x1c` を追加＋doc コメント
- [x] 4. `core/src/protocol/wtd-applier.ts` — 修正F: `applyWtd` の default を「次の ESC まで
      読み飛ばす」に変更。`applyDataStream` の doc コメントも差し替え
- [x] 5. `core/src/protocol/wtd-applier.ts` — 修正G-2+H: `case ORDER.UNKNOWN_1C` で
      `buf.setChar(addr++, "*")`（**rawByte を渡さない**）＋コメント
- [x] 6. `core/src/protocol/wtd-applier.ts` — 修正I: `applyWriteErrorCode()` に SO/SI・DBCS ペア処理
- [x] 7. `web-ui/src/components/ScreenGrid.vue` — 修正C: `.grid-line` / `.win-frame` /
      `.gui-window-border` に `margin: 8px 0 0 10px`
- [x] 8. `web-ui/src/components/ScreenGrid.vue` — 修正E: `hasRealColsep()` を追加し
      `cellClass()` / `attrByteClass()` の判定を差し替え
- [x] 9. `web-ui/src/components/ConfigCard.vue` — 修正J: `isServer` を `kind` で分岐し、
      セッションは親システム参照（`props.session?.ref ?? sesForm.system`）で判定

## テスト

- [x] 10. `core/test/wdsf-gui.test.ts` — T1: 実機トレース根拠の doc コメント追加
- [x] 11. `core/test/wdsf-grid-border.test.ts` — T2: value1/value2 既定値フォールバックの回帰
- [x] 12. `core/test/wdsf-applier-grid-lines.test.ts` — T3: 新規ファイル（2 件）
- [x] 13. `core/test/wtd-applier.test.ts` — T4: 未知オーダーのテストを復帰する挙動に書き換え
- [x] 14. `core/test/wtd-applier.test.ts` — T5: `0x1C` が `"*"` を書き `rawByte` が付かない
- [x] 15. `core/test/wtd-applier.test.ts` — T6: WRITE_ERROR_CODE の DBCS 実機トレース
- [x] 16. `web-ui/test/screen-grid-colsep.test.ts` — T7: 黄地・青緑地で `a-colsep` を出さない（2 件）
- [x] 17. `web-ui/test/config-card-ownership.test.ts` — T8: 修正J の再現テスト（原典に diff 無し・
      再現手順から書き起こし。**2 件**にした＝srv: と own: の両方向）

## 検証

- [x] 18. `npm run build`（tsc -b）が通る
- [x] 19. `cd packages/core && npx vitest run` — 74 ファイル / **851 件 pass**
- [x] 20. `cd packages/web-ui && npx vitest run` — 83 ファイル / **974 件 pass**
- [x] 21. `npx eslint .` — **変更ファイルは 0 エラー**。リポジトリ全体では 6 エラーが出るが、
      すべて**本作業と無関係の未追跡ファイル**（`scripts/*.mjs`。セッション開始時点の
      `git status` に既に `??` で存在）。`packages/web-ui/**` は eslint の対象外（`eslint.config.js:9`）
- [x] 22. `cd packages/web-ui && npx vue-tsc -b tsconfig.json tsconfig.test.json` — エラーなし
      （※ リポジトリルートからは `tsconfig.test.json` が無く失敗する。パッケージ dir から実行する）
- [x] 23. T8 が修正前のコードで fail することを確認
      （`isServer` を旧実装に戻すと `expected 'personal' to be 'server'` で 1 件 fail）
