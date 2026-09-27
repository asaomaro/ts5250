# テスト結果: READ の無い WRITE ERROR CODE

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1037 passed（`wec-only-unlock.test.ts` 6 件）
- `packages/server` `npx vitest run --testTimeout 60000` — 1618 passed / 3 skipped
- 実機（直した後）`scripts/verify-wec-only-unlock.mjs` — pass=3 fail=0。ホストの READ は `05 0a f1 11 05 0a c1 c2`（ACS は `05 0c …`。カーソルは (f) の差）
- 実機 `scripts/verify-wec-only-unlock.mjs WECTWICE` — pass=3 fail=0。READ は F3（溜めた Enter は捨てた。ACS と同じ AID。欄の差は research F4）
- 変異: 溜めた AID を送る分岐の `return`・WEC で捨てる・~~CC1 で捨てる~~（`20260927-unlocked-wtd-cursor` で撤回）・Attn で捨てる・WEC で施錠を解く、の 5 つが落ちた。送る前の `state = "locked"` は等価（すでに施錠中で、WEC が溜めを捨てる）なので行ごと外した
- 片付け: DLTPGM（CPC2191 → CPF9801）・IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log`

## 受け入れ基準ごとの判定
- AC1: pass（research F2・F4 を単体テストで固定）
- AC2: pass（上の実機 2 通り）
- AC3: pass

## 失敗の証跡
直す前の実機:

```
  FAIL 0x21 だけのレコードで施錠が解ける（ACS `initKeyboard`。エラー状態のまま）
  Reset → AB → Enter: "As400Error: keyboard is locked (state=locked)"
RESULT: pass=0 fail=2
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- decisions D2 の差
