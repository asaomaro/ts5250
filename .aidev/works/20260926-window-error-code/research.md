# 調査: WRITE ERROR CODE TO WINDOW（0x22）の ACS の振る舞い

## 調査の問い
- Q1: ACS は 0x22 の本文をどの行・どの桁に書くか。桁範囲の端は含むか。
- Q2: 本文が桁範囲より長いときの扱い。
- Q3: エラー状態の入り方・抜け方（文字の拒否・Reset・次の画面）。
- Q4: 当 PJ の今の振る舞い。

## 判明した事実
- F1（Q1・原典。`acshod2.jar` の `DS5250.processWriteErrorCode` を CFR と `javap -c` で読んだ。CFR の出力は `isWriteErrorCode` の間の呼び出しが落ちていたのでバイトコードで補った）:
  0x21 と 0x22 は同じメソッド。書き始め＝(SOH のメッセージ行 − 1)×桁数、終わり＝書き始め＋桁数。0x22 は **書き始め＋＝開始桁 − 1、終わり＝行頭＋終了桁 − 1**。
  次に **書き始め＋桁数 ＞ 画面の大きさ なら、書き始めを最下行の行頭へ戻す**（終わりは戻さない）。`PS5250.saveMsgLinePosition` が [書き始め, 終わり) の桁を空にして書き位置をそこに置き、
  本文は WTD と同じ処理（`processWriteToDisplay`）で書く。本文の長さの上限は **終了桁 − 開始桁 ＋ 1 バイト**（先頭が 0x13 なら ＋3）——戻す前の開始桁で数える。上限は `processWriteToDisplay` に渡す**データの添字の終わり**なので、
  属性・SO/SI・DBCS の 2 バイトもすべて 1 バイトずつ数える。**上限を超えたバイトは、0x22 のときだけ次の ESC まで読み飛ばす**（バイトコード 306〜331: `bl` のとき ESC(0x04) まで添字を進める）。
- F2（Q1・実測。`scripts/acs-probe/window-error-code.txt`・2026-09-27・社内機・930。0x22 は DSM で出させた——`scripts/host-src/dscmd.c` の WINERR*。ワイヤは `04 22 0C 1D 22 C5…` で指定どおり）:
  - メッセージ行が最下行（24・既定）: **桁 1 に属性、桁 2 から本文**（開始桁 12 は捨てられた。F1 の「行頭へ戻す」）。桁 1〜28 が空になり、桁 29 以降（`RESTORED`）は残る。
  - SOH でメッセージ行を 22 に申告: **桁 12 に属性、桁 13 から本文**。桁 12〜28 が空になり、桁 2〜11（`MSGLINE OR`）と桁 29 以降は残る。
- F3（Q2・実測）: 30 字の本文は、どちらの行でも **17 字（属性と合わせて 18 桁）で切れた**（`ABCDEFGHIJKLMNOPQ`）。22 行では桁 29（終了桁）まで書き、空にしていない桁 29 を上書きした。F1 の上限と一致。
- F4（Q3・実測と原典）: 0x22 の直後 `inhibit=5`（エラー状態）、文字 `x` は入らない。Reset で `inhibit=0` になり、**メッセージ行が元の内容に戻る**（`RESTORED` まで全部）。
  原典: エラー状態を抜けるのは `PS5250.clearErrorMode`（→ `restoreMsgLinePosition`）で、呼ぶのはキー操作のほか `DS5250.processClearUnit`・`processSaveScreen`。0x21 と同じ経路。
- F5（Q4・当 PJ。`packages/tn5250/src/protocol/wtd-applier.ts` の `COMMAND.WRITE_ERROR_CODE_WINDOW`）: 桁の 2 バイトを読み捨て、0x21 と同じ `applyWriteErrorCode` で本文を `systemMessage` に持つ（長さの上限なし）。
  UI は `systemMessage` を**最下行に重ねて**出す（`packages/web-ui/src/components/ScreenGrid.vue` の `.opmsg`。桁 1 を空けて桁 2 から）。実機の当 PJ（`scripts/verify-window-error-code.mjs`・変更前）: 4 通りとも位置の情報が無く、長い本文は 30 字のまま（pass=2 fail=6）。
- F6（当 PJ の寿命）: `systemMessage` は CLEAR UNIT・SAVE SCREEN で捨て、メッセージ行（`msgLineRow`）へ書き込みがあれば捨てる（`packages/tn5250/src/screen/buffer.ts` の `clearSystemMessageIfTouched`）。
  Reset 等で抜けると UI が隠す（`EmulatorPane.vue` の `hostErrorDismissedSeq`）。行の元の内容はセルに残っているので、隠せば元が見える＝ACS の復元と同じ見え方。

## 影響範囲
- core: `wtd-applier.ts`（0x22 の読み方）・`buffer.ts`（位置の保持・snapshot）・`types.ts`（snapshot の型）。
- web-ui: `ScreenGrid.vue`（`.opmsg` の位置）・`EmulatorPane.vue`（位置を渡す）。

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts:368` `case COMMAND.WRITE_ERROR_CODE_WINDOW` と `:997` `applyWriteErrorCode`。
- A2: `packages/tn5250/src/screen/buffer.ts` の `systemMessage` / `systemMessageSeq` / `msgLineRow`（`:193`・`:812`）と snapshot（`:1409` 付近）。
- A3: `packages/web-ui/src/components/ScreenGrid.vue` の `message` prop（`:143`）・`.opmsg`（`:4436` の template・`:4764` の CSS）。`.colsep` が同じ桁の置き方（`margin` に内側余白・`left` を ch・`top` を 1.25em 単位）。
- A4: `packages/web-ui/src/components/EmulatorPane.vue:1049` `hostMessage`・`:1604` `:message`。

## 実装時の注意
- 0x21 の位置（SOH のメッセージ行）は当 PJ も最下行に出しているが、requirements の対象外。F1 の原典では 0x21 も SOH の行に書くので、差として別項目に起票する。
- ACS は本文を**セルに書き**、抜けたときに元へ戻す。当 PJ はセルに書かず重ねて出す——重ねる範囲を ACS の「空にする桁＋書いた桁」に合わせれば、見え方は同じになる。
- 行頭へ戻すかの判定は「書き始め＋桁数 ＞ 画面の大きさ」。最下行以外では起きない。

## design への申し送り
- core で ACS と同じ位置（行・書き始めの桁・重ねる幅）と本文の上限を求め、snapshot に載せる。UI は載っていればそこへ重ねる（無ければ従来どおり最下行）。
- 0x21 の SOH の行の差は起票（D2 で決める）。
