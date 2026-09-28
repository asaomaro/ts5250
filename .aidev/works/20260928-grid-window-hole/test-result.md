# テスト結果: 罫線の寿命

## 実行したもの
- tn5250 1169 passed / web-ui 2964 passed / server 1672 passed（3 skipped）・lint・build・vue-tsc
- 実機の ACS のコア: `scripts/acs-probe/grid-lifetime.txt`（research F2）
- 実機（ブラウザ）: `scripts/verify-browser-grid-lifetime.mjs` — `RESULT: pass=7 fail=0`（2 回）
- mutation 6 通り中 6 検出

## 受け入れ基準ごとの判定
- AC1: pass — `wdsf-applier-grid-lines.test.ts`「窓と罫線」・`screen-grid-gridlines.test.ts`「窓の穴」・実機 G4
- AC2: pass — 「REM_ALL_GUI_CONSTRUCTS でも罫線は残る」・実機 G5
- AC3: pass — 「CLEAR GRID LINES の矩形」・実機 G6
- AC4: pass — 実機 7 巡

## 失敗の証跡

```
$ npx vitest run  (packages/tn5250, 0x5F・0x61 を変えた直後)
 FAIL  test/wdsf-applier-grid-lines.test.ts > CLEAR UNIT ALTERNATE と罫線の共存 > REM_ALL_GUI_CONSTRUCTS では引き続き罫線が消える（専用コマンドは効く）
 FAIL  test/wdsf-applier-grid-lines.test.ts > CLEAR UNIT と罫線・窓の共存（S9R167D 実機トレース） > REM_ALL_GUI_CONSTRUCTS は罫線も窓も両方消す（専用コマンドは変わらず効く）
 FAIL  test/wdsf-grid-border.test.ts > ScreenBuffer のグリッド線状態 > 描画・置き換え・消去・バッファクリア
      Tests  3 failed | 1164 passed (1167)
```
（旧挙動を固定したテスト。ACS の実測に合わせて書き換えた）

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39727)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 画面の大きさが変わるときの罫線（decisions D2）・内部の罫の持ち主（D3）
