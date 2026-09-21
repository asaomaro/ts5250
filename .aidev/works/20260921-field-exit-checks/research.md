# 調査: ACS の Field Exit・Field± の検査

## 判明した事実
- F1（原典）: `PS5250.processFieldPlusMinusAndExit` は欄が無ければエラー 5、入力不可（`isIOFieldField`）なら 4、ME で「カーソルが欄の先頭」か「MDT が無い」なら 33（0x21）、
  `checkMandatoryFillField(カーソル, true)`（MF・MDT あり・カーソルが先頭でない・満杯でも空でもない）に外れれば欄の先頭へ戻して 20（0x14）（符号付き数値の MF は除く）、
  Field− が数値の欄でなければ 22（0x16）。どれも消去・右寄せ・欄の移動の前に止まる。
- F2（実機・ACS のコア。`scripts/acs-probe/field-exit-checks.txt`。社内機の ADJPGM・FFWPGM）: ME の欄の先頭で Field Exit・2 桁目で Field Exit（MDT なし）・
  打ってから先頭へ戻って Field+ はエラー（「入力必須フィールドにはデータを入力しなければならない。」・inhibit=5・カーソルそのまま）、打ってそのまま Field Exit は
  次の欄へ。入力不可の欄では Field Exit・Field+ ともエラー（「この入出力フィールドにデータの入力は許されない。」）。
- F3（当 PJ）: `ScreenGrid.vue` の `fieldExitKey` / `fieldSignKey` は Field− の欄の種類だけを見ていた。MF は `EmulatorPane.vue` の欄を出た後の検査が戻す（消去の後）。
