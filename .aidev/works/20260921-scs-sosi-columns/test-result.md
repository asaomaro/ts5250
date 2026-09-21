# テスト結果: 帳票の SO/SI を ACS と同じ桁で描く

## 実行したもの
- scs 全テスト 62 passed（旧い「桁を占めない」を前提にした 10 件を ACS の描き方へ書き換え、SPCC の 5 件を追加）。
  使う側: server 1454 passed（3 skipped）・hostserver 991・web-ui のスプール関係 71
- 日本語機の DSPLIBL（生の SCS。リポジトリには入れない）: DBCS の説明（「システム・ライブラリー」）が SBCS の説明より 1 桁右から始まる（ACS と同じ）

## 受け入れ基準ごとの判定
- AC1: pass — 既定 1 桁ずつ・SPCC 00 00 / 00 01 / 00 02 / 00 03・長さ 2 と 3。
- AC2: pass — 印は SO/SI の桁の左端（`left:2ch` / `left:9ch`）。印の有無で行のマークアップは変わらない（既存テスト）。
- AC3: pass — mutation 6 通り（M-a〜M-f）すべて検出。

## 失敗の証跡
このラウンドでは実装の失敗は発生していない（旧い前提のテスト 10 件の書き換えは意図どおり。research F3・decisions D1）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- ACS そのものの出力（PDF・印刷）と並べてはいない（原典と、日本語機が送る SPCC の値から決めた）。
