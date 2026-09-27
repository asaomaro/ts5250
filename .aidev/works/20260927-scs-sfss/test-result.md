# テスト結果: SCS の SFSS

## 実行したもの
- `cd packages/scs && npx vitest run` — 88 passed / 0 failed（SFSS 2 件を追加。実採取の帳票のフィクスチャも不変）
- tn5250 1092 / server 1627（3 skipped 既存）/ web-ui 2859 passed（server・web-ui は別 PJ の負荷で時間切れが出て再実行で pass）
- `npx tsc -b`・`npm run lint` — エラーなし

## 受け入れ基準ごとの判定
- AC1: pass — 単体（倍幅の `AB` → `A B`・空白・HT も 2 桁・0x10 で戻る・半分は 1 倍・長さ 5 は受けない・長さ 3 は横だけ）。原典の読み
- AC2: pass — 台帳

## 変異（verify-by-mutation）
- 5 通りすべて検出（字の進みに掛けない・HT に掛けない・半分を倍にする・長さ 5 を受ける・0x10 で戻さない〔最初に生き残り、戻った後の字を足して検出〕）

## 失敗の証跡
このラウンドでは実装の失敗は発生していない。

## 未検証の穴（skip / 環境不足）
- 倍幅を含む実帳票を採っていない（原典の読み）。倍率がジョブをまたぐかは未確認（decisions D3）

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39310)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
