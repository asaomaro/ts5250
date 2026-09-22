# テスト結果: USER の条件

## 実行したもの
- tn5250 全量 — 798 passed / 0 failed。
- 実機（PUB400・変更前の測定）: 利用者名だけを送る・送らないの両方でサインオン画面、利用者名の欄は空（research F3）。
- 節目（マイルストーン 7）の独立点検への対応後: 全量 6,349 passed / 0 failed / 41 skipped（1 回目は既存のプリンターのテスト 1 件が並列の負荷で時間切れ。証跡は `20260921-device-name-acs` の test-result.md）・lint・build（vue-tsc 含む）通過。mutation 24 通り（`scratchpad/mut-m7.py`）と当て直し 2 通りをすべて検出。
- 空白だけのパスワードは単体（`telnet.test.ts`）。ACS は原典（`NVT5250` の末尾の空白を落としてからの空の判定）。

## 受け入れ基準ごとの判定
- AC1: pass — `telnet.test.ts`。
- AC2: pass — 条件を外す mutation で検出。

## 失敗の証跡
このラウンドでは失敗が発生していない（旧い振る舞いを固定していたテスト 1 件は、変更に合わせて書き換えた）。

このラウンドでは失敗が発生していない。

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
- 空白だけのパスワードを実機へ流していない（USER もパスワードも送らないので、ホストとのやり取りは記号の無い接続と同じ）。
