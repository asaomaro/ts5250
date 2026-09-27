# テスト結果: 0x21 のメッセージを SOH のメッセージ行に重ねる

## 実行したもの
- `npx vitest run packages/tn5250` — 922 passed / 0 failed / 0 skipped（84 files）
- `cd packages/web-ui && npx vitest run test/window-error-code.test.ts test/host-error-mode.test.ts …`（関連 3 files）— 38 passed / 0 failed
- `cd packages/web-ui && npx vue-tsc -b` — exit 0
- 実機: `node --env-file=.env --env-file=.env.verify scripts/verify-window-error-code.mjs` — pass=17 fail=0（2026-09-27・社内機・930）
- 変異: 0x21 の位置 3 通り（undefined／行 24 固定／幅 80 固定）・メッセージ行の戻し 4 通り（CLEAR UNIT／CLEAR FORMAT TABLE／CLEAR UNIT ALTERNATE／SOH の順序）・寿命の行 1 通り——すべてテストで落ちる

## 受け入れ基準ごとの判定
- AC1: pass — core のテスト（申告なし→{24,1,80}・SOH 22→{22,1,80}・90 字も 1 行・27×132→{27,1,132}）、web-ui の描画のテスト（22 行・桁 1・幅 80・本文は桁 2 から）、実機（WEC→24 行／WEC22→22 行／WEC22LONG→22 行・幅 80）が ACS の実測（research F2・F3）と一致。90 字の 23 行への続きは D2 で合わせない
- AC2: pass — 既存の 0x21・0x22・寿命・エラー状態のテストがすべて緑（0x22 の実機 4 通りも従来どおり）
- AC3: pass — 実機の検証スクリプトに 0x21 の 3 通りを足した
- AC4: pass — 測定後に `DLTPGM <AS400_LIB>/DSCMD`（CPC2191、CHKOBJ で CPF9801）と IFS の /tmp/dscmd.c・/tmp/dscmd.log を削除

## 失敗の証跡
このラウンドでは失敗が発生していない（点検の指摘で直した分は review.md のタスク点検ログ）。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45065)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```
新しい入口は足していない（smokeCommands は据え置き）。

## 未検証の穴（skip / 環境不足）
- 27×132 の 0x21 は実機で測っていない（ACS の原典 `DS5250.processClearFMT` の読みだけ。decisions D5）
- メッセージ行を最下行へ戻す規則（D5）と寿命の行（D6）は、実機の ACS／当 PJ で直接は測っていない（原典と単体テスト）
- 実機の当 PJ 側の測定は T1c（寿命の行）の修正前に回した——T1c は位置を変えないので、位置の結果には影響しない
- web-ui の全テストは回していない（関連 3 files のみ。他セッションの負荷のため）

## 再テスト（review ラウンド 1 の対応後）
- `npx vitest run packages/tn5250/test/window-error-code.test.ts packages/tn5250/test/system-message-lifetime.test.ts` — 40 passed / 0 failed（コメントの変更だけ）
- `dscmd.c` の `wecTest` の引数の順を揃えた（定義と呼び出しの両方）。**実機でのコンパイル・再測定はしていない**——入れ替えは定義と唯一の呼び出しで対になっており、測定時の組み合わせ（WEC／WEC22／WEC22LONG）と同じ値が渡る
