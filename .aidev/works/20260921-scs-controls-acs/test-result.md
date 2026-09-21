# テスト結果: SCS の制御を ACS に合わせる

## 実行したもの
- scs 全テスト 57 passed（新規 16 件）。使う側: server 1454 passed（3 skipped）・hostserver 991・tn5250 のプリンター 9・web-ui のスプール関係 71
- 実採取の帳票の新旧比較（PUB400 の SBCS / DBCS）: 1 桁も変わらない
- 日本語機の DSPLIBL（`scripts/verify-printer-dbcs-push.mjs` で採った生の SCS。実機の識別子を含むのでリポジトリには入れない）:
  先頭の「�」（SBCS の状態の SI）が出なくなった

## 受け入れ基準ごとの判定
- AC1: pass — 制御ごとのテスト 11 件。
- AC2: pass — 2B D1 06（SCG）8 バイト・C1 の長さ・FE・C8・表に無いクラス。
- AC3: pass — 新旧比較で差なし。mutation 10 通りすべて検出（1 回目は TRN を外す改変が生き残った——透過の本体が印字文字だけで
  通常の文字と区別できなかった。本体に 0x0D を混ぜたテストにして検出）。

## 失敗の証跡

```
$ python3 mut-scs.py   # 1 回目
S-d TRN を外す: 32 passed (32)
```
テストの弱さ（上記）。実装の誤りではない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- SO/SI の桁・タブ位置・重ね打ち・0xFF は対象外（台帳に残す）。RNL・RFF を含む実際の帳票は見つけていない（D1）。
