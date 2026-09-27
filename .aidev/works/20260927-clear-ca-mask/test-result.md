# テスト結果: CLEAR 系と CA キーの申告

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1037 passed（`aid-data-mask.test.ts` に CUA・CFT の 2 件）
- 実機 `scripts/verify-clear-ca-mask.mjs` — 直す前 pass=1 fail=2 → 直した後 pass=3 fail=0
- 変異: CUA の `aidNoDataMask = 0` を外す・CFT の同じ行を外す、の 2 つとも落ちた
- 片付け: DLTPGM（CPC2191 → CPF9801）・IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log`（2 回目の測定の後にもう一度）

## 受け入れ基準ごとの判定
- AC1: pass（research F2。ACS は 2 回）
- AC2: pass（research F4）
- AC3: pass

## 失敗の証跡
直す前の実機:

```
  FAIL CACUA: F3 の欄データが ACS と同じ（070c3311070ac1c2）
  FAIL CACFT: F3 の欄データが ACS と同じ（070c3311070ac1c2）
RESULT: pass=1 fail=2
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ENPTUI 構造体・画面サイズが変わったときの罫線（対象外）
