# 調査: WTD の中の否定応答・受理の残り

## 判明した事実
- F1: ACS `DS5250.processWriteToDisplay` の 0x11: 行 1・桁 0 は後ろにバイトがあれば番地 -1（無ければ SBCS は 0x10050122・DBCS は番地 0）。0x1D: 次のバイトが 0x40 以上なら FFW、FCW は 0x80 以上の間、属性は製品の ACS だけ 0x20〜0x3F を検査（`isValidStartOfFieldAttribute` → 0x10050130）、`addFieldToFFT` が失敗なら 0x10050125
- F2: `FFT5250.addFieldToFFT` が欄を入れない条件: 同じ位置に欄があれば FFW だけ書き換えて成功（`checkNewField`）。長さ 0・符号付き数値/DBCS の長さ 1・J/E は 4 以上の偶数・G は偶数・自己点検は 33 以下（`Field5250.checkFieldLength`）、画面の終わりを越える・600 欄、継続欄の順（`isValidContField`。`contFieldSegment` は `clearFFT` で戻らない）・行をまたぐ・MF/自己点検/符号付き数値/右寄せ（`checkFieldValidity`）
- F3: 実機の ACS のコア（DSM の WTDERR*・2 回・1 回目は tap）: SBA10 → 1 行 1 桁の入力欄に AB・NEXT・mw=true・否定応答なし / FFWC0 → 7,10 の入力欄・否定応答なし / TDEND・CHEND → 0x10050121・24 行は空・NEXT なし・mw=false（その後、ACS は後続の全レコードに 0x10050121 を返し続けた） / FLEN0・FLDEND・JODD・CONTMID → 0x10050125（1 回だけ）・欄なし・NEXT なし・mw=true
- F4: 当 PJ（直す前）: SBA10・FFWC0 は例外でレコードごと失う、TDEND は 012345 を書いて例外、CHEND は ACS と同じ
- F5: 製品の旗（`isAcsPackage`）は `acs-probe` のコアでは立たないので、0x10050130 は実機で測れない

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` の SBA・TD・`applySf`
- A2: `packages/tn5250/src/screen/buffer.ts` `addField`
