# テスト結果: WDSF の頭の検査

## 実行したもの
- tn5250 1105 / server 1629（3 skipped 既存。別 PJ の負荷で 1 件時間切れ、再実行で pass）/ web-ui 2864 passed。tsc・lint エラーなし
- 実機（社内機）`scripts/verify-wtd-order-sense.mjs WTDERRWDSFLL WTDERRWDSFCLS WTDERRWDSFTYPE` — pass=12
- ACS のコア（tap）: ENPTUI 無効・有効の 2 通り（research F2）
- 通常の画面の一巡（社内機・PUB400 で 24 画面ずつ）: 否定応答 0 件・WDSF の警告 0 件

## 受け入れ基準ごとの判定
- AC1: pass — 実機・単体
- AC2: pass — 単体（0x52・0x54・0x55）・実機の一巡

## 変異（verify-by-mutation）
- 6 通りすべて検出

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 未検証の穴（skip / 環境不足）
- 構造体ごとの中身の検査（decisions D1）・LL がレコードを越える形（D2）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39444)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
