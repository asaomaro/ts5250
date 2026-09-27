# テスト結果: FF だけの帳票の ACS の実出力（調査）

## 実行したもの
- `ECLHostPrintSession` の試行（research F1）——通信の開始から戻らず、測れなかった。実機の片付け: 残り 0

## 受け入れ基準ごとの判定
- AC1: pass — research F1・F2 と台帳

## 失敗の証跡
このラウンドでは失敗が発生していない（試行の失敗は research F1）。

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ACS の実出力そのもの
