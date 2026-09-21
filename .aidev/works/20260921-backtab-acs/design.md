# 仕様: Backtab の行き先

## 設計方針
- `backtab()`（EmulatorPane）: フォーカス中の入力欄について、継続欄の 2 区間目以降または欄の途中なら、並びの先頭区間（欄）の先頭へ。
  欄の先頭なら、そこへカーソル送りで来る入力欄があればそこへ。どれでもなければ従来の `focusByOffset(-1)`（前の停止点・位置での探索）。
- 欄の先頭の判定は ScreenGrid の `caretAtFieldStart()`（編集モデルの論理位置。keydown で native caret から取り直した後の値）。
- Backtab の後は常に `noteFieldExited()`（ACS は着いた欄の印を立てる。同じ欄へ戻っても 0020 にしない）。

## 依拠する既存の事実
- keydown は欄の input → ペインの順に届き、ScreenGrid が先に論理位置を取り直す（`onInputKeydown` の冒頭）。
- `tabStops` / `currentStopIndex` は継続欄を先頭区間で代表させる（`EmulatorPane.vue`）。

## 受け入れ基準との対応
- AC1: `backtab-acs.test.ts`（実測の 4 例。6,40 の自由カーソルは既存の位置探索のテスト）。
- AC2: 同（行またぎ・逆引き）と `continued-field-tab.test.ts`（最終区間 → 先頭区間）。
- AC3: 同（0020）と mutation。
