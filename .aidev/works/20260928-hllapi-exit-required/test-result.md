# テスト結果: HLLAPI のエラー 0x20

## 実行したもの
- `cd packages/server && npx vitest run` — 1672 passed / 3 skipped
- `cd packages/tn5250 && npx vitest run` — 1166 passed
- `npm run lint`・`npm run build`
- 実機の ACS のコア: `scripts/acs-probe/exit-required-aid.txt`・`exit-required-aid-arrow.txt`（research F2）
- 実機（当 PJ の HLLAPI）: `scripts/verify-hllapi-exit-required.mjs` — `RESULT: pass=12 fail=0`（2 回）
- mutation 6 通り中 6 検出（はじめ 2 つが生き残り、テストを足して検出）

## 受け入れ基準ごとの判定
- AC1: pass — 単体（止まる 5 件・別の欄を経る 1 件）と実機 E1・E2・E3・E5・E6a
- AC2: pass — 単体（送れる 3 件・欄の終わり・自動 Enter）と実機 E4
- AC3: pass — 上の実機

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。

```
$ npx vitest run test/hllapi.test.ts  (MF の順のテストを書き直す前)
     × MF の違反が先（欄頭へ戻す。0x20 はカーソルを動かさない——ACS の順） 15ms
AssertionError: expected last "vi.fn()" call to have been called with [ { index: 1 }, StringMatching /^9/ ]
```
（テストの画面に値が無く MF が効いていなかった——テストの誤り）

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38290)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 欄の終わりまで打った後（decisions D2）・Home と上下の矢印での着き直し（原典どおり、実機は Tab・Backtab だけ）
