# テスト結果: WDSF の構造体ごとの否定応答

## 実行したもの
- tn5250 1195 passed / web-ui 2964 passed / server 1672 passed（3 skipped）・lint・build
- 実機の ACS のコア: `scripts/acs-probe/wdsf-negative.txt`（research F2）
- 実機（当 PJ のコア）: `scripts/verify-wdsf-negative.mjs` — `RESULT: pass=15 fail=0`（2 回）
- mutation 7 通り中 7 検出

## 受け入れ基準ごとの判定
- AC1: pass — `wtd-order-sense.test.ts`「WDSF の構造体ごとの否定応答」17 件
- AC2: pass — 実機 15 巡

## 失敗の証跡

```
$ npx vitest run  (packages/tn5250, 検査を足した直後)
 FAIL  test/wdsf-gui.test.ts > WDSF GUI — 除去コマンド > REM_ALL_GUI_CONSTRUCTS で全 GUI を除去
 FAIL  test/wtd-order-sense.test.ts > WDSF の頭の検査（ACS の実測） > ACS が受ける型（0x55）は、当 PJ が効かせなくても否定応答にしない
      Tests  2 failed | 1176 passed (1178)
```
（崩れた長さを使っていたテスト。decisions D2）

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40513)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- マイナー構造体の長さ・罫線の値など（decisions D1）
