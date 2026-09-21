# テスト結果: 起動応答を CCSID 37 で読む

## 実行したもの
- tn5250 の起動応答・答え直し・プリンター（`startup-record.test.ts`・`startup-reject.test.ts`・`printer-session.test.ts`）— 52 passed / 0 failed。lint 通過。
- mutation: CCSID 37 の codec を 930 にすると 2 件落ちる（検出）。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 解析の単体とセッション（ccsid 930）の警告の装置名が `DSP$01`。
- AC2: pass — 上の mutation。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- 実機（D1）。
