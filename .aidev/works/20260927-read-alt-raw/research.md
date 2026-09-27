# 調査: READ の欄データの加工

## 判明した事実
- F1（原典 `DS5250.sendAll` の SBA 付きの枝。7・9・82〔0x52〕・130〔0x82〕・131〔0x83〕）: 欄ごとに内容を取り（継続欄は全区間を連結）、末尾の NUL（0）を落とす（ENPTUI の選択欄は除く）。
  0x52（と 9）だけ: 符号付き数値で**長さが欄の長さのまま（末尾の NUL を 1 つも落としていない）**なら、符号の桁が 0x60 のとき手前の桁を `(b & 0x0F) | 0xD0` にし（手前が数字かは見ない）、符号の桁を落とす。
  途中の NUL は 0x40（ENPTUI の選択欄・スクロールバー欄は除く）。0x82・0x83 はバイトをそのまま書く（NUL も符号の桁も）。**実空白（0x40）を落とす処理はどの枝にも無い**。
- F2（実測。2026-09-27・社内機・930。DSM の試験プログラム `scripts/host-src/dscmd.c` の READALT・`scripts/acs-probe/read-alt.txt`）。ホストの `QsnRtvFldInf` が分けた欄データ:

  | 欄（ホストが書いた中身。MDT あり） | ACS 0x83 | ACS 0x82 | ACS 0x52 | 当 PJ（変更前・3 つとも同じ） |
  |---|---|---|---|---|
  | 長さ10 `AB C`＋実空白 6 | `c1c240c3404040404040` | 同左 | 同左 | `c1c240c3` |
  | 長さ10 `A` NUL `B`＋NUL 7 | `c100c2` | `c100c2` | `c140c2` | `c140c2` |
  | 長さ6 符号付き `  012-` | `4040f0f1f260` | 同左 | `4040f0f1d2` | `4040f0f1d2` |
  | 長さ6 符号付き `   12 ` | `404040f1f240` | 同左 | `404040f1f2` | `404040f1f2` |

  当 PJ は `scripts/verify-read-alt.mjs` で同じ画面に当てた（pass=0 fail=3）。
  **2 回目（6 欄。独立点検の指摘で符号の手前が英字・空白の欄を足した）**: 最初の 4 欄は 1 回目と同じ値。`    A-` は ALT `40404040c160`・0x52 `40404040d1`、`     -` は ALT `404040404060`・0x52 `40404040d0`（原典どおり、手前が数字かを見ない）。
- F3（当 PJ）: `read-response.ts` の `sendValue` は `fieldValue`（末尾の空白を落とす）と `signedNumericValue`（符号を畳んで末尾の空白を落とす）を 0x52・0x82・0x83 で共用。
  NUL（空のセル）はバッファでは `null` のセル（`wtd-applier.ts` の `b === 0x00` → `eraseRange`）、ホストが書いた 0x40 は `rawByte` 付きの `char` のセル。`cellAt` で見分けられる。
  打鍵の値（web-ui は末尾の空白を落として送る＝`ScreenGrid.vue` の `trimmed`）は `setFieldValue` が値の後ろを `null` にする。
- F4（当 PJ）: セッションは 0x42 以外の READ を `buildReadMdtResponse` で返す（`session.ts` の `build`）。0x82 も 0x52 と同じになる。

## 実装アンカー
- A1: `packages/tn5250/src/protocol/read-response.ts` `sendValue` / `buildFieldResponse` / `buildReadMdtImmediateAltResponse`
- A2: `packages/tn5250/src/session/session.ts` の AID 応答の `build` の選択

## 実装時の注意
- 未編集の DBCS 欄は `fieldValue` が原本のバイト列を返し、1 桁 1 字にならない——桁ごとの NUL の判定ができないので従来の形に残す
- 既存のテスト（`signed-num-transmit.test.ts`）は打った空白を落とす前提で書かれている
