# テスト結果: 空ページ

## 実行したもの
- `packages/scs` `npx vitest run` — 86 passed（空ページ 4 件・HTML の白紙の描画 1 件）
- `packages/server` `npx vitest run test/pdf.test.ts` — 6 passed（白紙を含む 3 ページの PDF）。server 全体 1618 passed・web-ui 2822 passed・tn5250 1039 passed
- 変異: FF の `flushPage(true)` を戻す・`!keepEmpty` を外す・白紙の紙の幅を揃えない、がすべて落ちた

## 受け入れ基準ごとの判定
- AC1: pass

## 失敗の証跡
このラウンドでは失敗は発生していない

```
Tests  86 passed (86)
```

## 起動確認（smoke）
```
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ACS の実際の紙（出力）とは突き合わせていない（research F4）
- 副次効果: FF だけの帳票（HPT でない）は以前 0 ページで、画面の側（`PrinterPane.vue`）が「ホスト変換済みの印刷データです」と誤って出していた。いまは白紙 1 ページになり、この誤表示は出ない
