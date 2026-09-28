# テスト結果: HLLAPI の Tab・Backtab・Home で欄を出るときの MF・自己点検

## 実行したもの
- server `test/hllapi.test.ts` — 92 passed（「欄を出るときの MF・自己点検」14 件を足した）
- 全量: tn5250 1,105 passed／server 1,643 passed・3 skipped／web-ui 2,864 passed。`npm run lint` exit 0・`npm run build` exit 0
- mutation 14 通り（`scratchpad/mut-htm.json`）— すべて KILLED（同じ欄・非表示・保護欄・符号の桁・満杯・空・MDT・継続の並び・自己点検・SO/SI・止まっても続ける・欄頭へ戻さない・Home・Backtab）
- 実機（社内機）: `scripts/verify-hllapi-tab-mandatory.mjs` — pass=12 fail=0（ADJPGM。7,20 起点）。1 回目（7,21 起点）も rc と値の 8 件は一致（カーソルの 4 件は起点の空白で `XAB` になっただけ——欄頭に入っている）
- ACS のコア: `scripts/acs-probe/hllapi-tab-mandatory.txt` を 2 回（Backtab の欄頭の場合は 1 回）

## 受け入れ基準ごとの判定
- AC1: pass — ACS: Tab・欄頭からの Backtab・Home で 7,20・inhibit=5、Tab の後ろの CD は入らない。当 PJ: 同じ操作で rc=5・値 AB・次の字が欄頭に入る（実機）。単体で @T@E の Enter を送らない・@TCD の字を書かない
- AC2: pass — 単体（自己点検の合わない値で止まる・合う値は通る・MDT の無い自己点検欄も見る／空・満杯・MDT 無し・MF でない・非表示・符号の桁の手前まで埋まった欄は止まらない）
- AC3: pass — ACS も当 PJ も欄の途中からの Backtab は止まらない（実機・単体）

## 失敗の証跡
このラウンドでは失敗が発生していない（実機スクリプトの 1 回目の FAIL 4 件はスクリプトの起点の誤りで、実装の失敗ではない）:

```
  FAIL AB@B（欄の途中から） の後のカーソルは欄頭 7,20（次の字で "XAB"）
RESULT: pass=8 fail=4
```

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 39406)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
新しい入口は足していない（HLLAPI の既存のキーの振る舞い）。

## 未検証の穴
- 自己点検の欄を HLLAPI で実機に当てていない（ACS の Tab の検査数字エラーは `selfcheck-field-exit.txt` で実測済み。当 PJ は単体）
- 符号付き数値の自己点検で符号の桁を除く分岐は単体で突いていない
- ACS の HLLAPI（Windows のネイティブ層）がこのとき返す rc は測れない。当 PJ は入力禁止の欄へ打ったときと同じ rc=5 にした

## ラウンド 2（レビューの指摘を直した回）
- server `test/hllapi.test.ts` — 95 passed（DBCS の MF 3 件を足した）。server 全量 1,646 passed・3 skipped。`npm run build`・`npm run lint` exit 0
- mutation 7 通り（`scratchpad/mut-htm2.json`。新しい判定: SO を中身に数える・SI を無条件に／数えない・全角を中身に数えない・空・満杯・符号の桁）——1 回目に「SI を無条件に数える」が生き残った
  （J 欄のテストの SI が欄の末尾に無く、末尾の SI を数えても答えが変わらなかった）。SI を最終桁に置いて当て直し、すべて KILLED
- 実機 `scripts/verify-hllapi-tab-mandatory.mjs` — pass=12 fail=0（3 回目）

```
SI を無条件に数える SURVIVED Tests  95 passed (95)
```
