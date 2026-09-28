# テスト結果: WDSF 0x54

## 実行したもの
- tn5250 1178 passed / web-ui 2964 passed / server 1672 passed（3 skipped）・lint・build
- 実機の ACS のコア: `scripts/acs-probe/write-data.txt`（research F2）
- 実機（当 PJ のコア）: `scripts/verify-write-data.mjs` — `RESULT: pass=5 fail=0`（2 回）
- mutation 6 通り中 6 検出

## 受け入れ基準ごとの判定
- AC1: pass — `wdsf-gui.test.ts` D1・実機 D1（`NEWZ`・READ MDT で欄を送らない）
- AC2: pass — D2・D3・実機（CPFA304）
- AC3: pass — D4・実機 D4
- AC4: pass — 「形の分からない flag」

## 失敗の証跡

```
$ npx vitest run  (packages/tn5250, 0x54 を効かせた直後)
 FAIL  test/wdsf-gui.test.ts > WDSF GUI — 堅牢性 > 当 PJ が効かせない WDSF type は警告して読み飛ばす
 FAIL  test/wtd-order-sense.test.ts > WDSF の頭の検査（ACS の実測） > ACS が受ける型（0x54・0x55）は、当 PJ が効かせなくても否定応答にしない
      Tests  2 failed | 1172 passed (1174)
```
（0x54 を読み飛ばす旧挙動を固定したテスト。0x55 に移した）

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40649)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- CCSID の形・DBCS の継続欄（decisions D1）・語送りの欄の後処理
