# 調査

## 判明した事実
- F1: 原典（R11 の `key-edit-rest` (b)）: `PS5250.eraseToEOF_Work` は続く区間を全桁 NUL に、`processDupFM` は 0x1C で埋め、欄を出る行き先は `FFT5250.nextNonByPassInputFieldPos`（継続欄の 2 区間目以降を飛ばす）。
- F2: 実機の ACS のコア（社内機・930。dump は `scratchpad/cont-erase-exit*.out`）: B1・B1b（Erase EOF）、B2・B4・B5（Field Exit。カーソルは最初の入力欄へ巡回）、B6・B7（画面の途中の鎖からの Field Exit はカーソルが次の欄 21,24）、B3・B3b（DUP 可の継続欄の Dup は続く区間を 0x1C で埋め、カーソルは次の欄）。すべて原典の読みどおり。
- F3: 当 PJ は `eraseEofKey`・`fieldExitKey`・`fieldSignKey`・`dupKey`（`ScreenGrid.vue`）が `edit`（1 区間）だけを扱い、`onFieldFull`（`EmulatorPane.vue`）は行き先を `(cur + 1) % els.length`（次の区間）にしていた。

## 実装アンカー
- A1: `fillFollowingSegments`（新規。`commitFieldValueDirect` の隣）と、上記 4 つのキー（`packages/web-ui/src/components/ScreenGrid.vue`）。
- A2: `onFieldFull`・`indexAfterLeaving`（`packages/web-ui/src/components/EmulatorPane.vue`）。
