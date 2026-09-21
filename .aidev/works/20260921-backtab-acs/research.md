# 調査: ACS の Backtab

## 判明した事実
- F1（原典）: `PS5250.processBacktab`: DBCS のセッションでカーソルの 1 つ手前が SO なら 1 つ戻し、`previousNonByPassInputFieldPos(カーソル−1)`。
  見つかればそこへ（見つからなければ動かない）。着いた欄に `setFieldExitReqFlag(true)`（`processTab` は出た欄に立てる——非対称）。
  `previousNonByPassInputFieldPos(n)`: カーソル送りが有効（`cursorProgressOn`＝FCW 0x88 を持つ欄がある）で、n+1 が欄の先頭なら、
  その欄へ送る（`getNextFieldToProgress` がその欄の番号の）非バイパス欄の先頭。無ければ「開始が n 以下の最後の欄」から前へ、
  バイパスと継続欄の先頭以外の区間を飛ばして最初の欄。無ければ最後の欄へ回り込む。
- F2（実機・ACS のコア。`scripts/acs-probe/backtab-home.txt`。ADJPGM）: 7,22 → 7,20 ／ 7,20 → 5,20 ／ 3,20 → 19,20 ／ 6,40 → 5,20 ／ 7,26 → 7,20。
  **1,1 では DBCS（930）のセッションで ACS のコアが `ArrayIndexOutOfBoundsException: Index -1` で止まる**（位置 −1 の SO を調べる）。
- F3（当 PJ）: `EmulatorPane.vue` の `onLocal("shift-tab")` → `focusByOffset(-1)`（前の停止点。欄の外からは位置で探す＝F1 と同じ規則）。
  停止点は継続欄の先頭区間だけ（`tabStops`）。カーソル送りは前向きだけ（`progressionStop`）。0020 の待ちはカーソルが欄を出たら外れる。
