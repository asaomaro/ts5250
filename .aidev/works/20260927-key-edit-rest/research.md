# 調査: キー編集の細部の残り

## 判明した事実
- F1（原典 `AcsMapFunctions.MAP_5250`）: `A512 = ¢`（`VK_AT`＝@ の単独キー）・`A92 = ¬`（\）・`A45 = £`（-）。~~台帳の「Alt+@ は ¬・Alt+\ は ¢」~~ は逆。`A19 = [test]`（Alt+Pause）。
  ほかに当 PJ に無いのは `C17 = [newline]`（Ctrl 単独）と GUI の操作（新しいセッション等の番号の割当）だけ。
- F2（原典 `PS5250.processHome`）: 居る位置がホーム位置（`homePos`＝IC か先頭の非バイパス欄の先頭）なら Record Backspace、違えばホーム位置へ移り、そこが SO の桁なら 1 つ進める。
  J 欄のホーム位置は SO の桁なので、移った後の位置（SO の次）はホーム位置と一致せず、何度押しても Record Backspace にならない。
  **実測**（DSM の JHOME・`scripts/acs-probe/j-field-home.txt`）: Home を 3 回押してカーソルは 5,11 のまま、READ は最後の Enter（`05 0b f1`）。当 PJ（直す前）は 2 回目で Record Backspace を送った（単体テスト）。
- F3（原典 `DS5250` の SOH 分岐・`FFT5250.moveCursorToInput`）: SOH の本体 1 バイト目の 0x10 で `setCursorMoveToInput`。矢印（1004〜1007）で非バイパスの欄の外に着いたら
  左右は行の中・次（前）の行へ、上下は着いた番地から左右の候補の番地の差で近い方（右が `右 − 着いた ≤ 着いた − 左`）。`processClearFMT` で下ろす。
  **実測**（DSM の CSRINP / CSRFREE・`scripts/acs-probe/csr-input-only.txt`。入力欄 5,10・5,40・9,20）: → で 5,16 → 5,40、← で 5,39 → 5,15、↓ で 6,15 → 9,20、↑ で 8,20 → 5,40、
  9,26 → 5,10、6,26 → 9,25。フラグ 0 の対照は 1 桁ずつ動いた。
- F4（原典 `DS5250.sendAid`）: 108・110・107（PA1〜3）は READ が出ているときだけ、ヘッダ＋カーソル＋AID を送る（欄データ無し）。61（Test）はヘッダのフラグ 0x02 だけ。
  **実測**（DSM の JHOME・`scripts/acs-probe/pa-keys.txt`）: AB を打って PA1 → `07 0c 6c`・PA3 → `07 0c 6b`。Test Request のワイヤ（`tap-proxy`）は `00 0a 12 a0 00 00 04 02 00 00`、ホストは CANCEL INVITE と「機能キーは使用できません。」を返した。
- F5（当 PJ）: `AidKey` に PA・Test が無く、HLLAPI は `@x`/`@y`/`@z` を「5250 に無いキー」として rc=20 で断っていた。3270 の `planKey3270` は PA1〜3 を既に扱う。

## 実装アンカー
- A1: `packages/web-ui/src/stores/keybindings.ts`・`composables/useKeymap.ts`・`components/ScreenGrid.vue` の `onInputKeydown`
- A2: `packages/web-ui/src/components/EmulatorPane.vue` の `homeKey`・`moveCell`
- A3: `packages/tn5250/src/screen/buffer.ts` の `setHeaderData`・`packages/tn5250/src/session/aid-keys.ts`・`session.ts` の `sendAid`・`read-response.ts` の `NO_DATA_AIDS`
- A4: `packages/server/src/macro-types.ts`・`mcp-tools.ts`・`hllapi-keys.ts`
