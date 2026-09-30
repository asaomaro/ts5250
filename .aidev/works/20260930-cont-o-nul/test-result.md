# テスト結果: 継続した O 欄の空きと空白

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1267 passed / 0 failed（`o-chain-send.test.ts` に 4 件）
- `packages/server` `npx vitest run` — 1695 passed / 0 failed / 3 skipped
- `packages/web-ui` `npx vitest run`（パッケージ dir から） — 3036 passed / 0 failed（`o-chain-cells.test.ts`・`o-chain-edit.test.ts` の期待を空き〔U+0000〕に合わせて直し、新規 `o-chain-erase.test.ts`）
- `npm run build`（tsc -b）・`npm run build -w @ts5250/web-ui`（vue-tsc）・`eslint`（core の変更分）— 通過
- 実機（ブラウザ）: `verify-browser-cont-o.mjs`（C01〜C12。**C09・C10 の末尾の `40` まで**）— pass=24 fail=0／`verify-browser-cont-o-paste.mjs`（P1〜P8。READ MDT ALT）— pass=13 fail=0（P3 と P4 のカーソルは既知の差で比べない）。修正前は C09・C10 が末尾の `40` を欠き、P4・P7・P8 が ALT で `40`（ACS は `00`）
- 変異: 30 通り。20 が初回から KILLED、7 が SURVIVED（鎖の末尾の空白を落とす・空白の生バイト〔2 か所〕・明示の並びの中の U+0000・Erase EOF の空き・続く区間の空き・列ビューの空白）→ 試験を足して KILLED。残り 3（`insert`・`del` の `fill` と `oApply` の鎖の印）は呼び出しが無い／結果が同じ**死んだ引数だったので消した**

## 受け入れ基準ごとの判定
- AC1: pass — `o-chain-cells.test.ts`（空白で埋めた鎖は押し出す・満杯は 0012・Delete・往復）
- AC2: pass — 実機 C01〜C12 が末尾まで一致
- AC3: pass — `o-chain-send.test.ts`（ALT の空き 00・空白 40・末尾の空き・空白・generic の経路）
- AC4: pass — 実機 P1・P2・P4（バイト）・P5〜P8

## 失敗の証跡
このラウンドでは失敗が発生していない（単体は初回で通った。既存の鎖のテストの期待は意図した変更〔空き＝U+0000〕に合わせて直した。変異の生き残りは試験を足して殺した）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 貼り付けで全角が区間の残りに入らないとき（P3）は ACS と違う（台帳に残す）
- 継続でない O 欄・J・E の値の空き/空白の区別、(d)(e)(f) は未着手（台帳）
