# 調査: WDSF 0x54

## 判明した事実
- F1（原典 `ENPTUI5250.processWriteData`・`PS5250.writeString`・`eraseField_Work`）: flag の 0x40 は CCSID の形、0x80 は EBCDIC の形。0x80 は今の番地が欄の先頭でなければ 0x10050140、
  データの長さ（LL−6）が欄の長さ（継続欄は鎖の合計）を越えれば 0x10050141。収まれば欄を消し（MDT が立っていれば立てたまま、無ければ立てない。J 欄・全角の E 欄は両端の 1 桁の内側）、
  継続でない欄は `writeString` で書いて今の番地が進み、継続欄は区間ごとに書いて番地を戻す（DBCS の区間は SO/SI で閉じ直す）。語送りの欄はこの後に語送り。どちらでもない flag は 0x10050140。
- F2（実機・ACS のコア・2026-09-28。DSM の WRITEDATA・`scripts/acs-probe/write-data.txt`）: D1 `NEWZ`・READ MDT で欄を送らない／D2・D3 ホストの読みが CPFA304／D4 `ABCD`/`EFGH`/`IJ`。
- F3（当 PJ）: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWdsf` は 0x54 を「効かせない型」として警告するだけ。

## 実装アンカー
- A1: `wdsf-parser.ts`（0x54 の flag とデータ）・`wtd-applier.ts` の `applyWdsf` と WDSF の呼び出し（番地を進める）・`buffer.ts`（欄を消す）
