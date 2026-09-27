# テスト結果: O 欄の挿入の必要桁（SO/SI 込み）を ACS に合わせる

## 実行したもの
- `cd packages/web-ui && npx vitest run`（全件。load 17〜19 の中で実行）— **2797 passed / 0 failed**（213 files）
- `npx vue-tsc -b`（web-ui。test も型検査の対象）— exit 0
- 新しいテスト `packages/web-ui/test/dbcs-insert-sosi-room.test.ts` — 23 passed
- 関連の既存テスト（dbcs・insert・ime・paste 系 19 ファイル）— 298 passed

## 受け入れ基準ごとの判定
- AC1: pass — 非継続の O 欄で C3（`A`・SO・`あいう`・SI・`B`＋空き 2、`B` の桁へ全角）・C4（同じ欄の最初の全角へ半角）が 0012・値は変わらない（打鍵・貼り付け・IME の確定の 3 経路とも）。
  ACS 側の結果は実機の ACS のコアで測定済み（`scripts/acs-probe/dbcs-insert-room.txt` の C3・C4）。当 PJ の判定は画面の中身だけで決まるので、同じ中身・カーソル・字の画面を単体テストで作って確かめた。
- AC3: pass — 背景の表の B2・B3・C1・C2・F1、C5、並びの中の全角へ全角・半角の中へ半角・並びの中ほどの全角へ半角、境界（空き＝必要桁）が従来どおり／ACS どおり。既存の DBCS 系テストも全て緑。
- AC4: pass — ACS の継続欄の手順を原典で確かめて research F7 に記録し、差があるので decisions D3 で別項目に割った（起票は deliver で `acs-parity.md` に）。

## 失敗の証跡
このラウンドでは失敗が発生していない（coding 中の mutation で落としたものは review.md のタスク点検ログに記録）。

mutation（coding 中に実施）: 検査の呼び出し・(i)(ii) の必要桁・境界（`<`→`<=`）・継続欄の除外・`replaced` の除外・空きの数え方・IME の 1 字目に限る修正——いずれも戻すとテストが落ちる。
生き残った 3 つは等価変異（decisions D5）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 44841)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 当 PJ 側の実機（ブラウザで DSM の DBCSFE 画面を開いて打鍵）では確かめていない。判定はホストに問い合わせず画面の中身だけで決まり、ACS 側は実機で測ってあるので、単体テストの画面で代えた。
- 入ったあとのバイト列の差（decisions D2）と継続欄（D3）は、この work では扱っていない（別項目に起票）。
