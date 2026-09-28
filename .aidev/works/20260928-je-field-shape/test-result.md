# テスト結果: J・全角の E の欄の送るバイト列

## 実行したもの
- `npx vitest run --root packages/tn5250` — 1199 passed / 0 failed
- `npx vitest run --root packages/server` — 1672 passed / 0 failed / 3 skipped
- `cd packages/web-ui && npx vitest run` — 2978 passed / 0 failed（その後マクロの 1 件を足して `macro-record`・`je-field-shape` を再実行: 38 passed）
- `cd packages/web-ui && npx vue-tsc -b` — OK
- `node --env-file=.env --env-file=.env.verify scripts/verify-browser-je-field.mjs` — `RESULT: pass=3 fail=0`
- 変異 18 通り（形の導出・上書き・消去・切り替え・新しい画面・空の値・持ち回り・送信・コアの NUL・マクロ）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass — `packages/web-ui/test/je-field-shape.test.ts`（14 件）・`packages/tn5250/test/je-field-send.test.ts`（4 件。ACS の測定値のバイト列）
- AC2: pass — 実機（DSM の JEEDIT）でブラウザから ACS のコアと同じ打鍵を当て、ホストが受け取った 3 巡の READ MDT が ACS の J1〜J3 と一致

## 失敗の証跡
このラウンドでは差し戻しになる失敗は発生していない（実装中に `edits` へ印入りの値を入れた試みで web-ui が 30 件落ちたのは decisions D1 の経緯）。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40349)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ACS の測定は 1 つの画面（JEEDIT）の 23 通り。伏せ字の E・Dup・継続した J/E は対象外（台帳の「E 欄の残り」）
