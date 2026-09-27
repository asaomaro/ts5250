# テスト結果: 継続欄の O への挿入の ACS の測定

## 実行したもの
- 実機の ACS のコア（社内機・930・`PROBE_ENPTUI=true`）`scripts/acs-probe/cont-o-insert.txt` — 4 通りの dump（台帳に記録）
- 実機の片付け: `<AS400_LIB>/DSCMD` を DLTPGM（CPC2191 → CHKOBJ で CPF9801）・IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を削除

## 受け入れ基準ごとの判定
- AC1: pass — 台帳の「継続欄（O）への挿入の余地の数え方」に記録

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 未検証の穴（skip / 環境不足）
- 当 PJ の側は測っていない（web-ui の打鍵。直す作りと一緒に）。1 回の観測（measurement-sanity の 2 回目は直すときに取る）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 37834)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
