# 調査: 欄を出ないまま AID を押したとき（ACS のエラー 0020）

## 調査の問い
- Q1: ACS はどの欄で・どの条件で送らずにエラーにするか（原典）
- Q2: 実機の ACS はどう振る舞うか（Enter 以外のキー・出方・欄の中の移動）
- Q3: 当 PJ で「欄を出た」をどう表すか

## 判明した事実

### F1: 原典（`PS5250.processAIDCode`・`Field5250`。`javap -p -c -constants`）
- AID の前に、**カーソル下の欄**（`fft.getField(cursorSBA)`）について順に見る:
  1. `checkMandatoryFillField` が偽 → カーソルを欄頭へ、`setErrorCode(20)`
  2. **（符号付き数値 ∨ 右寄せ 0 埋め ∨ 右寄せ空白埋め）∧ `isMDTField` ∧ ¬`isFieldExitReqFlag` ∧ ¬`fieldExited` ∧ ¬自動 Enter
     → `setErrorCode(32)`（＝0x20。表示は 0020）で送らずに戻る**。カーソルは動かさない
  3. `checkModulusField` が偽 → `setErrorCode(21)`、カーソルを欄頭へ
  4. 最後に `performMandatoryEnterFieldCheck` が偽 ∧ ¬`isSOH_PF(aid)` → `setErrorCode(7)`
- 検査を飛ばす AID は **0xF3（Help）・0xBD（Clear）・0xF8（Record Backspace）・0x3D** と、Help 系の内部コード。
  **CA キーを外す分岐は無い**。
- `Field5250.fieldExitReqFlag` は**打鍵で下り**（`PS5250.setMDT`）、**欄を出る操作で立つ**
  （`processTab` / `processBacktab` / `processHome` / `processNewline` / `processCursorMove` /
  `processFieldPlusMinusAndExit` / `processDupFM` ほか）。欄を作った時点では立っている（`addFieldToFFT`）。
- `fieldExited` は、FER 型の欄（`isFieldExitRequired`＝FER・RB・RZ・符号付き数値）の**最終桁まで打った**ときに立つ。

### F2: 実機（`scripts/acs-probe/aid-without-field-exit.txt`。ADJPGM）
**各場合の終わりに Reset → Tab → F3 で抜け、`exit-*` がメインメニューであることを確かめた**（全 13 場合で成立）。

| # | 操作 | 結果 |
|---|---|---|
| 1 | RZ(A) に `12` → Enter | **エラー**（inhibit=5・カーソル 3,22 のまま・送らない） |
| 2 | RZ(A) に `12` → F3（CA03） | **エラー**（CA キーも止まる） |
| 3 | RZ(A) に `12` → Field Exit → Enter | 送れた（`000012`） |
| 4 | RZ(A) に `12` → Tab → Backtab → Enter | 送れた（**左詰めの `12    `** が届く） |
| 5 | RZ(A) に `12` → 右矢印（欄の中）→ Enter | **エラー**（欄の中の移動では出たことにならない） |
| 6 | 6S0 に `12` → Enter | **エラー** |
| 7 | RB(A) に `12` → Enter | **エラー** |
| 8 | 素の A に `12` → Enter | 送れた |
| 9 | RZ(A) に `12` → カーソルを素の A へ → Enter | 送れた（RZ は左詰めのまま届く） |
| 10 | RZ(A) を満杯（6 桁）→ Enter | 送れた（カーソルは欄末に留まる＝`fieldExited`） |
| 11 | 6S0 の数字桁を満杯（5 桁）→ Enter | **エラー** |
| 12 | RZ(A) に `12` → PageDown（Roll） | **エラー** |
| 13 | RZ(A) に `12` → Help | 0020 ではない別の反応（「機能キーは使用できません」） |

ACS が最下行に出す文言: 「このフィールドには実行キーは許されていない。」

⚠ **1 回目の取り方は無効だった**。画面の CHECK(ME) 欄が空だと Enter が ME エラー（カーソルが ME 欄へ移る）で止まり、
場合の終わりの F3 が 0020 で弾かれて、次の場合の `CALL` が欄へ打ち込まれた。以降の場合が全部持ち越しで汚れ、
「F3 は通る」と読める結果が出ていた。ME 欄を先に埋め、抜け出しを dump で確かめる形にして取り直した。

### F3: 当 PJ の現状
- 送信の合流点は `session-controller.ts` の `sendKey`（ボタン・キー・ホイールがすべて通る）。
  必須検査（ME/MF/自己点検）は **Enter のときだけ**、全欄を内容で見る（`mandatoryCheck.ts`）。0020 に当たる検査は無い。
- セッション状態のカーソル（`s.cursor`）はホスト由来だけ。ローカルのカーソルはペインの `cursorOverride`。
- 編集はペインの `onEdit`、欄を出る操作は ScreenGrid の `field-full`（Field Exit / Field± / Dup / 満杯の自動送り）と
  カーソルの移動。新しい画面では `sessionsStore.updateScreen` が編集差分を捨てる。

## 実装アンカー
- A1: 判定（`packages/web-ui/src/session-controller.ts` `sendKey`）
- A2: 欄の種類（`packages/web-ui/src/composables/mandatoryCheck.ts`）
- A3: 待ちの付け外し（`packages/web-ui/src/components/EmulatorPane.vue` `onEdit` / `onFieldFull` / `onLocal` の erase-input）
- A4: 新画面・予約での破棄（`packages/web-ui/src/stores/sessions.ts` `updateScreen` / `setReserved`）

## 未確認
- 場合 11（符号付き数値の数字桁を満杯）: 当 PJ は満杯で次の欄へ自動送りするので、欄を出たことになり送れてしまう。
  ACS は RB/RZ/符号付き数値の欄を満杯でも自動送りしない（`isFieldExitRequired`）——台帳の「RB/RZ 欄のフィールド終了」の範囲。
- Help で出た「機能キーは使用できません」の出所（ACS かホストか）。
