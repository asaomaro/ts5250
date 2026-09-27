# テスト結果: 解錠中の WTD と溜めた AID のカーソル

## 実行したもの
- `packages/tn5250` `npx vitest run test/wec-only-unlock.test.ts` — 7 passed。tn5250 全体・server は前の実行で緑（server 1618 passed）
- 実機 `scripts/verify-unlocked-wtd-cursor.mjs` — pass=3（UNLOCKWTDNOIC は区別しない。research F2）
- 実機 `scripts/verify-wec-only-unlock.mjs` WECONLY / WECONLYW / WECTWICE — それぞれ pass=3。READ は `050cf111050ac1c2` / `050cf111050ac1c2` / `050a33…`
- 変異: 押したときのカーソルを使わない（`undefined` に戻す）で落ちた。CC1 で捨てない側は、CC1 0x20 のテストが送ったバイト列を見る
- 片付け: DLTPGM（CPC2191 → CPF9801）・IFS の `/tmp/dscmd.*`。タップの記録は shred

## 受け入れ基準ごとの判定
- AC1: pass / AC2: pass / AC3: pass

## 失敗の証跡
このラウンドの直す前（WECONLYW・当 PJ。CC1 で捨てて READ に返さず、ホストの READ が戻らなかった）:

```
  ホストの READ が受けた: undefined
RESULT: pass=2 fail=1
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- decisions D1・D2 の未確認（CC1 0x20 以外・明示の IC・送った後の画面のカーソル）
