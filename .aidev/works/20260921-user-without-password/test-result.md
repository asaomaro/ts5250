# テスト結果: USER の条件

## 実行したもの
- tn5250 全量 — 798 passed / 0 failed。
- 実機（PUB400・変更前の測定）: 利用者名だけを送る・送らないの両方でサインオン画面、利用者名の欄は空（research F3）。

## 受け入れ基準ごとの判定
- AC1: pass — `telnet.test.ts`。
- AC2: pass — 条件を外す mutation で検出。

## 失敗の証跡
このラウンドでは失敗が発生していない（旧い振る舞いを固定していたテスト 1 件は、変更に合わせて書き換えた）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-user-without-password
smoke: /healthz ok, / が Web UI を返した (port 45509)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 社内機（`*FRCSIGNON`）では測っていない。
