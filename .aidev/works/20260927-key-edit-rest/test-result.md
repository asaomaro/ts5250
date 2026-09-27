# テスト結果: キー編集の細部の残り

## 実行したもの
- `packages/tn5250` 1051 passed・`packages/server` 1619 passed / 3 skipped・`packages/web-ui` 2840 passed・`npm run lint` エラーなし・`vue-tsc -b` エラーなし
- 実機 `scripts/verify-pa-test-keys.mjs` — pass=5（PA1 `070c6c`・PA2 `070c6e`・PA3 `070c6b`・Test Request の後も続けて打てる）
- 実機の ACS のコア: JHOME（Home ×3 で 5,11 のまま）・CSRINP / CSRFREE（CSRINP は 2 回とも同じ 8 か所）・PA1 / PA2 / PA3・Test Request のワイヤ
- 変異: 文字の割当を投げ直さない・ペインで AID として扱う・エラー中に文字として拒否しない・欄外で 0005 を出さない・Home で SO の次へ進めない（どちらかの守りを外す）・CSRINPONLY の配線を外す・SAVE/RESTORE で復元しない・Test Request を施錠中に通す、がそれぞれ落ちた
- 片付け: DLTPGM（CPC2191 → CPF9801）・IFS の `/tmp/dscmd.*`・タップの記録は shred・作業用の `scripts/.tmp-*.mjs` を消した

## 受け入れ基準ごとの判定
- AC1〜AC5: pass

## 失敗の証跡
直す前の当 PJ（J 欄の Home）:

```
- Expected
+ Received
- []
+ [
+   "RecordBackspace",
+ ]
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- web-ui の Home・CSRINPONLY・Alt の文字は実機のブラウザでは確かめていない（ACS の実測値を単体テストに固定）
- decisions D1・D2・D4 の未確認
