# 調査: ME（必須入力）・MF（必須埋め）・自己点検を ACS はいつ・何で判定するか

## 判明した事実

### F1: 原典（`javap -p -c -constants`）
- `PS5250.processAIDCode`（Help・Clear 等を除く AID）の順:
  1. カーソル下の欄 `checkMandatoryFillField` が偽 → 欄頭へ、`setErrorCode(20)`（0x14）
  2. 0020（欄を出ずに AID。`20260921-aid-without-field-exit`）
  3. カーソル下の欄 `checkModulusField` が偽 → `setErrorCode(21)`（0x15）、欄頭へ
  4. `performMandatoryEnterFieldCheck` が偽 **かつ `DS5250.isSOH_PF(aid)` が偽** → `setErrorCode(7)`
- `Field5250.checkMandatoryFillField`: MF・`isMDTField`・¬満杯・¬全ヌル で違反。
- `FFT5250.checkMandatoryFieldCheck`: 非バイパスの ME 欄で `isMDTField` が偽のものがあり、**`PS5250.getMasterMDT()`
  （画面のどこかが変更済み）なら**その欄の位置を返す。内容は見ない。
- `DS5250.isSOH_PF(aid)`: F1〜F24 の AID について SOH の 3 バイトのビットを見る（＝CA キー）。
- `Field5250.checkModulusField`: MDT は見ない。
- `PS5250.moveCursorWithMandFillCheck`: 出る欄の MF・自己点検を見て、違反ならエラー・欄頭へ。
  呼び出し元は `processTab` / `processBacktab` / `processHome` / `processNewline` / `processCursorMove` /
  `processFieldPlusMinusAndExit` / `processDupFM` / `canCursorMoveByMouse` ほか。

### F2: 実機（`scripts/acs-probe/mandatory-me-mf.txt`。ADJPGM）
各場合の終わりに Reset → Tab → F3 で抜け、`exit-*` がメインメニューであることを確かめた（9 場合とも成立）。

| # | 操作 | 結果 |
|---|---|---|
| 1 | 何も打たずに Enter（ME 欄は空） | **送れた**（画面が未変更なら ME は見ない） |
| 2 | 素の欄に打って Enter（ME 空） | **ME エラー**・カーソルは ME 欄へ。「入力必須フィールドである。データを入力しなければなりません。」 |
| 3 | 素の欄に打って F3（CA03。ME 空） | **送れた**（CA キーは ME を見ない） |
| 4 | 素の欄に打って PageDown（ME 空） | **ME エラー**（Roll でも見る） |
| 5 | ME を埋め、MF に `AB`（カーソルは MF）で Enter | **MF エラー**・欄頭（7,20）。「全桁入力フィールド。終わりまで入力しなければなりません。」 |
| 6 | MF に `AB` で Tab | **MF エラー**・欄頭（欄を出るときも見る） |
| 7 | ME を埋め、MF に `AB`、カーソルを素の欄へ（ECL の setcursor）で Enter | **送れた**（`AB` のまま。AID ではカーソル下の欄だけ） |
| 8 | ME に打って Backspace（MDT あり・空）で Enter | **送れた**（ME は内容ではなく MDT） |
| 9 | MF に `AB`（カーソルは MF）で F3（CA03） | **MF エラー**（CA キーでも MF は見る） |

※ 場合 7 の setcursor は ECL の直接指定で、GUI のマウス移動（`canCursorMoveByMouse`）の検査は通らない。

### F3: 当 PJ の現状
- `session-controller.ts` `sendKey`: **Enter のときだけ**、`findMandatoryViolation` で**全欄を内容で**見ていた
  （`20260729-ffw-behavior-bits` D1）。欄を出るときの検査は無い。
- SOH の CA キーのマスクはコア（`ScreenBuffer.aidNoDataMask`）にあるが、スナップショットに出ていない。
- ステータスバーの AID ボタンは**ホストのカーソル**（`state.cursor`）で送っていた。

## 未確認
- 空白だけを打った MF 欄（ACS はヌルだけを空とみなす。当 PJ は空白も空）。
