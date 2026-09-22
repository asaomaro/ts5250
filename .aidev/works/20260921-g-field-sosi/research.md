# 調査

## 判明した事実
- F1: 原典（R11 の `key-edit-rest` (j)）: ACS の G 欄は SF の受理（`addFieldToFFT`）で全桁を DBCS の対として印付け、WEA タイプ 5 の 0x81／0x80 は `NLSPlane` の区間の印（`writeExtAttribute`）。送信は生の `HostPlane` で G は SO/SI 無し。
- F2: 実機（社内機・930）の DDS の G・J・E・O 型（`build-gtest.mjs`）: WTD の生バイトは `11 03 13 24 12 05 81 44 81 44 82 44 83 40 40 40 40 40 40 12 05 80`（G）。ACS の READ 応答は `11 03 14 44 86 44 87 44 88 40 40 40 40 40 40`（G）・`11 05 14 0e 44 86 44 87 44 88 40 40 40 40 0f`（J）。
- F3: 当 PJ の旧実装の出力: 受信 `､ｱ､ｲ､ｳ`・送信 `11 03 14 0e 44 86 44 87 44 88 0f`（ホストに `F0 0E 44 86 …`）。J は短い形でもホストが `0e … 40 40 40 40 0f` に整える。
- F4: web-ui は `dbcsByteLength`・`dbcsViewLayout`・`padDbcs` が SO/SI を数え、詰め物は半角空白。

## 実装アンカー
- A1: `wtd-applier.ts` の WEA と DBCS 復号、`buffer.ts`（`isPureDbcsAt`）、`read-response.ts`（`writeValue`・`buildFieldResponse`・`buildFlatFieldResponse`）（`packages/tn5250/src`）。
- A2: `ScreenGrid.vue`（`noShift`・`byteLen`・`padDbcs`・`trimPad`・`soMark`/`siMark`・`absorbDbcs`・`keepByteLength`）、`fieldValidate.ts`（`dbcsByteLength`）、`mandatoryCheck.ts`（`isFull`）（`packages/web-ui/src`）。
