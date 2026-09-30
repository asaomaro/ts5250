# テスト結果: 半角の状態の E 欄の空きと空白

## 実行したもの
- web-ui 3066 passed・tn5250 1277 passed・server 1695 passed / 3 skipped（既存）、lint・vue-tsc 緑
- 実機（ブラウザ）: `verify-browser-space-typed.mjs` pass=9（f2〜f4 が ACS と一致。J の ALT は未対応の欄）、either-remainder 4、either-empty-view 7、je-field 3、o-field 3、cont-o 24 — 全て fail=0
- 変異 9 通り — 8 を検出、1 つは等価（decisions D4）

## 受け入れ基準ごとの判定
- AC1: pass — `o-field-nul.test.ts`（E の節）・`o-field-send.test.ts`・実機の f2（READ MDT・ALT）
- AC2: pass — `o-field-nul.test.ts`（手前の空き・End・挿入・必須埋め）
- AC3: pass — 実機の既存スクリプトが一致のまま

## 失敗の証跡
このラウンドでは失敗が発生していない。修正前の f2 は `c1`（ACS は `c1 40`）で、`20260930-nul-typed-space` の走行（test-result の失敗の証跡）で記録済み。最初の変異走行で生き残った 4 件（挿入・End・core の並びの空白と生バイト）はテストを足して検出した。

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- open の E の全角空白と通常の SBCS の欄は対象外（台帳）
