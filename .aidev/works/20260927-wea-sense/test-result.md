# テスト結果: WEA の否定応答

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1031 passed
- 実機 `scripts/verify-wtd-order-sense.mjs WTDERRWEA1 WTDERRWEA5X WTDERRWEAEND WTDERRWEA5` — **pass=16 fail=0**（WTDERRWEA5 は PUB400・37。当 PJ は画面のサインオンで PUB400 に入れた——ACS のプローブが通らなかったのはプローブの画面の読み取りの側）
- 変異（実際に当てた）: 画面の外の検査を外す・SBCS のセッションの条件を外す・値の検査を外す、の 3 つがすべて落ちた（`wtd-applier.test.ts`・`dbcs-pure-field.test.ts`）
- 片付け: 社内機と PUB400 の両方で `DLTPGM <LIB>/DSCMD`（CPC2191 → CHKOBJ CPF9801）、IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を削除。タップの記録は `shred -u`

## 受け入れ基準ごとの判定
- AC1: pass — research F2 の値を単体テストで固定
- AC2: pass — 実機 pass=16
- AC3: pass — 上の片付け

## 失敗の証跡
このラウンドでは失敗は発生していない

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-wtd-order-sense.mjs WTDERRWEA1 WTDERRWEA5X WTDERRWEAEND WTDERRWEA5
RESULT: pass=16 fail=0
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 社内機は SBCS の装置を自動構成しないので、SBCS のセッションは PUB400 だけで測った
