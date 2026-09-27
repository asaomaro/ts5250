# テスト結果: READ の欄データの加工

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1030 passed（この work の変更だけの時点。以後の未コミットの WEA の下書きは含めない）
- `packages/server` `npx vitest run --testTimeout 60000` — 1618 passed / 3 skipped
- 実機（社内機・930）`scripts/verify-read-alt.mjs` — 修正前 pass=0 fail=3 → 修正後 pass=3 fail=0（6 欄 × 0x83・0x82・0x52 が ACS のコアと同じバイト列）
- 変異 6 通り（末尾の空白を落とす・ALT で NUL を空白に・符号の NUL の条件を外す・0x83 を mdt に・手前が数字のときだけ・セッションの 0x82 の選択）がすべて落ちた。DBCS の退避路を消す変異は落ちない（review.md）

## 受け入れ基準ごとの判定
- AC1: pass — `read-alt-raw.test.ts`・`signed-num-transmit.test.ts`・`read-input-fields.test.ts`
- AC2: pass — 実機 pass=3
- AC3: 片付けは次の work（WEA の否定応答）の測定の後にまとめて行う（同じ DSCMD を使う）

## 失敗の証跡
このラウンドでは差し戻しになる失敗は発生していない（修正前の実機の食い違いは research F2）

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-read-alt.mjs
RESULT: pass=3 fail=0
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 未編集の DBCS 欄（SO/SI の構造を持つ欄）の ALT は従来の形のまま（ACS と違う。台帳）
