# テスト結果: 継続した O 欄の貼り付け（P3）と単独の SO/SI の Delete

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 3050 passed / 0 failed / 0 skipped（230 ファイル）
- `cd packages/tn5250 && npx vitest run` — 1267 passed / 0 failed（core は変更なし）
- `npm run lint` — エラーなし／`vue-tsc -b` — エラーなし
- 実機（ブラウザ）: `scripts/verify-browser-cont-o-lone-shift.mjs`（D1〜D8。バイト列とカーソル）— pass=16 fail=0
- 実機（ブラウザ）: `scripts/verify-browser-cont-o-paste.mjs`（P1〜P8。P3 を含む。P4 のカーソルは操作の違いで比べない）— pass=15 fail=0
- 変異 10 通り（`oChainCells.ts` の貼り付けの止め条件・カーソル・挿入モード・エラー・詰め直し・`warn`、`ScreenGrid.vue` の貼り付けの配線・`warn` の反映・MDT）— 全て検出

## 受け入れ基準ごとの判定
- AC1: pass — `o-chain-paste.test.ts`（P1〜P4 の実測どおり）と実機の P1〜P8 の一致
- AC2: pass — `o-chain-edit.test.ts`「貼った字が今の字と同じでも欄は MDT」（変異 `grid-paste-mdt` を検出）
- AC3: pass — `o-chain-cells.test.ts`（D1・D2・D7・D8）と実機の D1〜D8 の一致
- AC4: pass — `o-chain-cells.test.ts`（D3・D4）と実機の D3・D4（欄が送られない）

## 失敗の証跡
このラウンドでは失敗が発生していない（実装前の当 PJ は D1・D2 が欄を送らず、P3 は 2 つ目の区間へ字を置かないことをコードで確認した。実機の修正前の走行は取っていない）。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 40901)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 0065 の操作員メッセージの文言は ACS と違う（バイト列には出ない。台帳）
- 実機の修正前の走行（不一致を出した証跡）は取っていない。単体の変異検査で代替した
