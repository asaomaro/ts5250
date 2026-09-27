# テスト結果: エラー状態のままメッセージ行へ WTD・RESTORE が来たとき（調査）

## 実行したもの
- 実機（2026-09-27・社内機）: ACS のコア（ERRMSGWTD・ERRMSGRST を 2 通りの形で）と当 PJ（`scripts/verify-error-msgline-wtd.mjs`）。片付け済み
- コードの変更は無い（測定の資産だけ）ので単体テストは回していない

## 受け入れ基準ごとの判定
- AC1: pass — research F1・F3
- AC2: pass — research F2・台帳の起票（deliver）
- AC3: pass — DLTPGM（CPC2191・CHKOBJ で CPF9801）・IFS の削除・ワイヤの記録の shred

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 46571)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- SysReq 中の WTD・0x22 の WTD の部分の保留は測っていない（起票に残す）
