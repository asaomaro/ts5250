# テスト結果: SSLD

## 実行したもの
- `packages/scs` `npx vitest run test/scs.test.ts` — 56 passed（SSLD 2 件〔長さ 1 のテストは既存の it に足した〕）。`packages/scs` 全体 81 件・server 1618 件も緑
- 変異: `col !== 1` を外す・幅の検査を外す・長さ 4 の検査を外す・長さ 2 以上のガードを外す、がすべて落ちた（独立点検でもさらに 7 通り）

## 受け入れ基準ごとの判定
- AC1: pass

## 失敗の証跡
このラウンドでは失敗は発生していない

```
Tests  56 passed (56)
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実機の帳票では未実測（行の途中に SSLD を置く帳票を作らせる手段が無い。research F4）
