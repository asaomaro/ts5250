# テスト結果: 符号付き数値の欄の MF・自己点検で符号の桁を数えない

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 2960 passed / 0 failed
- `cd packages/server && npx vitest run` — 1660 passed / 3 skipped
- `npm run lint`
- 実機の ACS のコア: `scripts/acs-probe/sign-digit-check.txt`（a 出られた・b 止まった・c 出られた・d 止まった）
- 実機（ブラウザ）: `scripts/verify-browser-sign-digit.mjs` — `RESULT: pass=4 fail=0`（2 回）。直す前のコードでは `pass=3 fail=1`（a）
- mutation: 5 通り中 5 検出

## 受け入れ基準ごとの判定
- AC1: pass — `mandatory-sign-digit.test.ts` の MF 3 件・実機の a / b
- AC2: pass — 同じく自己点検 1 件・実機の c / d
- AC3: pass — 既存の web-ui 全件

## 失敗の証跡
（検証スクリプトの誤りで落ちた回。実装の修正は要らなかった——decisions D2）

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-browser-sign-digit.mjs
  PASS a MF 数字 5 桁: 欄を出た（ACS も出た）
  FAIL b MF 数字 3 桁: 欄に留まり操作員メッセージ（ACS も止まった。stayed=false msg=false）
  PASS c 自己点検 12302: 欄を出た（ACS も出た）
  FAIL d 自己点検 12305: 欄に留まり操作員メッセージ（ACS も止まった。stayed=false msg=false）
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38994)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 符号の桁が `-` の場合（Field−）は単体だけ（実機の場合は符号の桁が空）
