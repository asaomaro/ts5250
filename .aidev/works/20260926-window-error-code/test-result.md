# テスト結果: 0x22 のメッセージを ACS と同じ行・桁に出す

## 実行したもの
- `npx tsc -b`（root）— exit 0／`npx vue-tsc -b`（web-ui）— exit 0
- `packages/tn5250` 全件 — **913 passed**（84 files。新しい `window-error-code.test.ts` 19 件を含む）
- `packages/web-ui` 全件 — **2803 passed**（214 files。新しい `window-error-code.test.ts` 6 件を含む）
- `packages/server` 全件 — **1614 passed / 3 skipped**（skip は既存のもの）
- 実機（当 PJ）: `node --env-file=.env --env-file=.env.verify scripts/verify-window-error-code.mjs` — **pass=8 fail=0**（変更前は pass=2 fail=6）

## 受け入れ基準ごとの判定
- AC1: pass — 実機の 4 通り（最下行／SOH で 22 行 × 短い／30 字）で、当 PJ の snapshot の本文・行・書き始めの桁が実機の ACS のコア（research F2・F3）と一致:

```
WINERR: systemMessage="ERR IN WINDOW" area={"row":24,"col":1,"width":28}
WINERRLONG: systemMessage="ABCDEFGHIJKLMNOPQ" area={"row":24,"col":1,"width":28}
WINERR22: systemMessage="ERR IN WINDOW" area={"row":22,"col":12,"width":17}
WINERR22LONG: systemMessage="ABCDEFGHIJKLMNOPQ" area={"row":22,"col":12,"width":18}
RESULT: pass=8 fail=0
```

  範囲の外のセルは変わらない（core のテスト）。描画は同じ位置を与えた `EmulatorPane` のテストで確かめた（行・桁・幅・高さ）。
- AC2: pass — 0x22 でも通し番号が振られてエラー状態に入る（core）、Reset で消える（web-ui）。既存の 0x21 のテスト（`write-error-code`・`system-message-lifetime`・`host-error-mode`）は全件緑。ACS 側は実測で inhibit=5・`x` を拒否・Reset で元の行に戻る（research F4）。
- AC3: pass — research F1〜F4（原典のバイトコードと実測）。測定の手順を残した: `scripts/host-src/dscmd.c` の WINERR / WINERRLONG / WINERR22 / WINERR22LONG、`scripts/acs-probe/window-error-code.txt`、`scripts/verify-window-error-code.mjs`。
- AC4: pass — CLEAR UNIT・SAVE SCREEN・メッセージ行への WTD で本文も位置も消える（core のテスト）。WTD の場合の ACS の見え方は未確認（design・decisions D4）。
- AC5: pass — 測定の後に `DLTPGM ASAOLIB/DSCMD`（CPC2191。`CHKOBJ` で CPF9801＝無いことを確認）と IFS の `/tmp/dscmd.c`・`/tmp/dscmd.log` を削除した。
  build のときに以前の work が残した `DSCMD` があり、`build-dscmd.mjs` が消して作り直した（それも含めて消えた）。ワイヤを採った中継の記録（パスワードを含む）は `shred -u` で消した。

## 失敗の証跡
このラウンドでは失敗が発生していない（coding 中の mutation と独立点検の指摘は review.md のタスク点検ログに記録）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- 本文が属性で始まらない 0x22、上限の境界にオーダー・DBCS の組がまたがる場合、終了桁が桁数を超える場合、RESTORE SCREEN との関係——いずれも ACS 側を測っていない（decisions D4・design）。
- 実ブラウザでの見え方（重ねた箱の位置）は単体テストの style で確かめた。実機の画面をブラウザで開いての目視はしていない。
