# テスト結果: カーソル送りの番号が並びの外なら動かない

## 実行したもの
- tn5250 1166 passed / web-ui 2962 passed（全件の一巡で 2 件が負荷で落ち、単独で再実行して 41 passed）/ server 1660 passed（全件の一巡で 8 件が負荷で落ち、単独で再実行して 32 passed——既知の負荷の揺れ）
- `npm run lint`
- 実機の ACS のコア: `scripts/acs-probe/progression-range.txt`（research F2）
- 実機（ブラウザ）: `scripts/verify-browser-progression-range.mjs` — `RESULT: pass=3 fail=0`（2 回）
- mutation 5 通り中 5 検出

## 受け入れ基準ごとの判定
- AC1: pass — 単体（`tab-backtab-position`・`cursor-progression-nav`）と実機 a
- AC2: pass — 単体と実機 c
- AC3: pass — 単体（表の数を超える 6・0・並びの中の 3）と実機 b

## 失敗の証跡
このラウンドでは実装の失敗は発生していない（負荷の揺れの再実行は上）。

```
$ npx vitest run test/delete-word.test.ts test/window-error-code.test.ts  (packages/web-ui)
      Tests  41 passed (41)
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38222)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- Field Exit・Field±・Dup で並びの外（decisions D2）
