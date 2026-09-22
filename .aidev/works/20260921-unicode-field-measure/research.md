# 調査: 測り方

## 判明した事実
- F1: DDS の A 型に `CCSID(…)` を付けるとコンパイルが落ちる（37・930・1200・1399・13488）。G 型なら `CCSID(13488)`・`CCSID(1200)` が通る（実機で確認）。
- F2: CL の `DCLF` は、Unicode の欄を含む表示装置ファイルで `CRTBNDCL` が CPF0820 で落ちる。ILE C のレコード入出力（`_Ropen`・`_Rwriterd`）なら通る（`scripts/host-src/unitst.c`）。
- F3: 当 PJ のトレース（`traceRecords`）と ACS のコア（`scripts/acs-probe.mjs`）の 2 経路で受ける。

## 実装アンカー
- A1: `scripts/build-unitest.mjs`（DDS と C をホストへ作る・`--clean` で消す）、`scripts/diag-unifield.mjs`（当 PJ で受ける）、`scripts/acs-probe/unicode-field.txt`（ACS のコアで受ける）。
