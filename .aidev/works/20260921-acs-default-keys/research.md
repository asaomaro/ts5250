# 調査: ACS の既定のキー割り当て

## 判明した事実
- F1（原典）: ACS では `DefaultKeyboardRemap.getMapFile` が `BaseEnvironment.isAcsPackage()` のとき `AcsMapFunctions.MAP_5250` を使う
  （HOD の `Map5250.map` は `B27 = [clear]`・`S155 = [paste]` で別物。ACS では使われない）。
- F2（原典）: `MAP_5250` のうち当 PJ の既存機能に当たるもの: `B27 = [attn]`・`S27 = [sysreq]`・`A35 = [erinp]`・`S155 = [dup]`・`B19 = [clear]`・
  `C19 = [printhost]`・`A112 = [help]`・`C112 = [dspsosi]`・`C114 = [altview]`・`B35 = [eof]`・`B155 = [insert]`・`C10 = [fldext]`・`S10 = [newline]`・`B109` / `B107`（テンキーの ±）。
- F3（原典）: `ECLPS` の keyData / keyValue で `[eof]` = 1001・`[eraseeof]` = 63739 は別物。`PS5250` は 1001 を `processEndField`（欄の末尾へ移る）、
  63739 を `processEraseEOF` に振る。**B35（End）は Erase EOF ではない。**
- F4（原典）: `processEndField` は `Field5250.getEndPosition` を使う——欄の終わりから非空白を探し、見つけた桁が最後の桁ならそこ、そうでなければ次の桁、
  無ければ欄の先頭。欄の外なら `nextNonByPassInputFieldPos` で次の入力欄へ。
- F5（原典）: `[printhost]` = 63660 → AID 246（0xF6 = Print）、`[clear]` = 27 → 189（0xBD）、`[help]` = 63693 → 243（0xF3）（`PS5250` の `AIDKeyTBL`）。
- F6（原典）: `[altview]` は `CodePage.toggleAltView`（930⇄939・1399⇄1390 の表示切替＝当 PJ の表示コード）、`[dspsosi]` は `toggleSOSIDisp`（SO/SI 表示）。
  **ACS の Ctrl+F1 は SO/SI 表示、Ctrl+F3 は表示コード**。当 PJ の既定（`4a3a575b`）は逆だった。
- F7（当 PJ）: `keybindings.ts` の版 1〜3 に Esc・Pause・Shift+Insert・Alt+F1 などの割り当ては無い。ScreenGrid は Insert（修飾が Shift だけでも）と End を
  欄の中で自分で処理し、ペインへ伝えない。
