# テスト結果: WDSF の中身の読み方

## 実行したもの
- tn5250 1174 passed / web-ui 2964 passed / server 1672 passed（3 skipped）・lint・build
- 実機の ACS のコア: `scripts/acs-probe/wdsf-behaviour.txt`（research F2）
- 実機（ブラウザ）: `scripts/verify-browser-wdsf-behaviour.mjs` — `RESULT: pass=4 fail=0`（2 回）
- mutation 7 通り中 7 検出

## 受け入れ基準ごとの判定
- AC1: pass — `wdsf-gui.test.ts` W1・実機 W1
- AC2: pass — W2・実機 W2
- AC3: pass — 「方向・総数・つまみ位置・サイズを解析」（300）
- AC4: pass — W3・W4・実機 W3・W4
- AC5: pass — 「位置の一致しない 0x58・0x59」

## 失敗の証跡

```
$ npx vitest run  (packages/tn5250, 2 進に変えた直後)
 FAIL  test/wdsf-gui.test.ts > WDSF GUI — DEFINE SCROLL BAR FIELD (0x53) > 方向・総数・つまみ位置・サイズを解析
 FAIL  test/wdsf-session.test.ts > Session5250 — 拡張 5250 GUI（合成リプレイ E2E） > enhanced=true で接続し、GUI 画面の snapshot.gui を露出する
      Tests  2 failed | 1167 passed (1169)
```
（10 進 4 桁を固定したテスト。2 進に書き換えた）

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40545)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 窓からはみ出す構造体の外し方（decisions D1）
