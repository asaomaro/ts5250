# 調査: 全角の状態の E・J の欄のカーソルの桁と End

## 判明した事実
- F1: ACS は全角の状態の E を SO の次から Erase EOF すると SO を残し、カーソルは SO の次（17,11）。そこへ い を打つと `0e 4482`・カーソル 17,13、先頭で X を打つと半角へ切り替えて `e7`・17,11
  （実機の ACS のコア `scripts/acs-probe/either-empty-type.txt`・2026-09-28）
- F2: ACS `Field5250.getEndPosition` は、J・全角の E では SO・SI の桁を除いた内側を後ろから見て、0x40 と NUL をバイトで飛ばす（全角空白 `40 40` も飛ぶ。SI〔0x0F〕は飛ばない）。
  実機の ACS のコア（`scripts/acs-probe/je-field-end.txt`・DSM の JEEDIT・2026-09-28）: J の `あい`＋全角空白 5,15・空の J 3,11・compact の E 11,14（SI の後ろ）・
  open の E 13,13・切り替えた E 9,13・空にした全角の E 13,11。原典の読みと 6 通りとも一致（別経路の確認）。ホストが受け取ったのは `11090a0e448140404040404040400f110d0a0e`
- F3: 当 PJ の DBCS の欄の列ビューは論理値から組む（`packages/web-ui/src/composables/fieldValidate.ts` の `dbcsViewLayout`）。空きの詰め物は J・G だけ全角空白（`ScreenGrid.vue` の `wideFill`・`padDbcs`）で、
  E は半角空白——全角の字の後ろが半角空白だと暗黙の SI が挟まり、空の E には SO の桁が無い。直す前のブラウザ（同じ検証）は End の 5 通りが ACS と違った（例: 空の J 3,19）
- F4: `fieldEdit.end` は半角空白だけを飛ばす（`packages/web-ui/src/composables/fieldEdit.ts` の `end`）

## 実装アンカー
- A1: `ScreenGrid.vue` の `padDbcs`・`trimPad`・DBCS の End（`onDbcsKeydown`）
- A2: `fieldEdit.ts` の `end`
