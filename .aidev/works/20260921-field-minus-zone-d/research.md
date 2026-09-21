# 調査: ACS の数値専用の欄の Field−

## 判明した事実
- F1（原典）: `PS5250.processFieldPlusMinusAndExit` は数値専用の欄（`isNumericOnlyField`）で Field− なら、欄の最終桁（`getEndPos()`）の `HostPlane` を
  `& 0x0F | 0xD0` にし、表示（`TextPlane`）はそのバイトの文字にする（`EnableFieldMinus` の設定が無いとき）。
- F2（実機・ACS のコア。社内機。`scripts/acs-probe/field-minus-numeric-only.txt`）: ADJPGM の数値の欄は既定で**符号付き数値**（`000012-`）で、この経路ではない。
  FFWPGM のシフト M の欄（6 桁）で `12` と Field− → `12   }`、`5` と Field− → `5    }`（最終桁が空でも 0xD0）。
- F3（当 PJ）: `fieldEdit.ts` の `fieldSign` は符号付き数値の欄だけを扱い、数値専用の欄は Field Exit と同じだった。送信はセンチネル（生バイト）をそのまま書く
  （`read-response.ts`）、送信時の型検査はセンチネルを外す（`field-validate.ts`）。
