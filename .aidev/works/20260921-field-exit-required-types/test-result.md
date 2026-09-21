# テスト結果: Field Exit 必須の欄を ACS と同じく扱う

## 実行したもの
- web-ui 全量 `npx vitest run` — 2246 passed / 0 failed
- 本 work のテスト: `ffw-behavior-bits.test.ts`（RZ・RB・RZ＋自動 Enter の 3 件）・`aid-field-exit-required.test.ts`（場合 10・11 の 2 件）

## 受け入れ基準ごとの判定
- AC1: pass — RZ・RB（自動 Enter 付きも）は満杯でも field-full も aid も出さない。
- AC2: pass — RZ を 6 桁まで打てば Enter が送られる。符号付きは数字桁 5 桁を埋めても 0020 で送られない。
- AC3: pass — mutation F1（判定を FER ビットだけに戻す）→3 件 / F2（境界で待ちを外さない）→1 件が落ちた。
  F3（符号付きの除外を外す）は生き残り、除外は不要と分かったので外した（D1）。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザ・実機での確認は未実施（jsdom。ACS 側は `20260921-aid-without-field-exit` の実測を使った）。
- 満杯で留まるカーソルの位置が ACS と 1 桁違う（D3）。そこでさらに打ったときの ACS は未測定。
