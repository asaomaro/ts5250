# テスト結果: 節目 9・10 の懸念と関連付けプリンターの残りの整理

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 2859 passed / 0 failed（`field-sign-dup.test.ts` 27 件）
- `cd packages/tn5250 && npx vitest run` — 1090 passed、`cd packages/server && npx vitest run` — 1627 passed / 3 skipped（既存。別 PJ の負荷〔load average 24〕で 4 件が時間切れになり、負荷が下がって再実行で pass）
- `npm run lint`・`npx tsc -b` — エラーなし

## 受け入れ基準ごとの判定
- AC1: pass — 単体（A → 0xD1・M → 0xD4・Z → 0xD9）。原典（`processFieldPlusMinusAndExit`）
- AC2: pass — 台帳の 3 項目を閉じ、「節目の懸念の残り（測る手段がある分）」に移した

## 変異（verify-by-mutation）
- 3 通りすべて検出（A〜I・J〜R・S〜Z を表から外す。J〜R は最初に生き残り、M のテストを足して検出）

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。

## 未検証の穴（skip / 環境不足）
- Field− の英字は実機の ACS で測っていない（ホストが数値専用の欄に英字を入れた画面を作っていない）。原典の読み
- この PR には #431 の直し（server の単体の SEND を IBM i の形に替えた。`20260927-telnet-rest`）も載る

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38942)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
