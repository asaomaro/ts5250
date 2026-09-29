# 調査: 応答の中身のタイミング

## 調査の問い
- Q1: ACS は 1 本のレコードの `[READ SCREEN][WTD]` で、応答をどの時点の画面で組むか
- Q2: 当 PJ はどの時点の画面で組んでいたか

## 判明した事実
- F1: 実機の ACS のコア（DSM の READSCRTIMING〔`scripts/host-src/dscmd.c`〕・`scripts/acs-probe/read-screen-timing.txt`・relay のワイヤ・2026-09-29）で、
  `[READ SCREEN][WTD で (5,10) を OLD→NEW]` の応答（1920 桁の画面）には OLD（D6 D3 C4）が入り、NEW は入らない。対照の `[WTD][READ SCREEN]` には NEW が入る。
  SAVE SCREEN でも同じ形の対（SAVETIMING）で、退避の本体（Java の直列化を zlib で圧縮。画面の字は UTF-16）に前者は OLD・後者は NEW——命令の時点で組む
- F2: 当 PJ の直す前の実機の結果: `[READ SCREEN][WTD]` の応答は NEW（`scripts/verify-read-screen-timing.mjs`: `FAIL READSCRTIMING: ["NEW"]（ACS: OLD）`・`PASS READSCRTIMING2`）。
  原因は `packages/tn5250/src/session/session.ts` の応答ループが `applyDataStream` でレコード全体を適用した後に `buildReadScreenResponse(this.buf, …)` を呼ぶこと
- F3: SAVE SCREEN は `buf.saveScreen()` がすでに命令の時点で画面を退避スタックへ取る（`wtd-applier.ts` の SAVE_SCREEN の case）。応答の本体（`buildSaveScreenResponse`）は
  レコードの後で組むが、ホストは RESTORE でそのまま返してくるだけで、当 PJ の RESTORE は積荷を適用せずローカルの退避スタックから復元する
  （`save-screen.ts` の冒頭の注記）。よって SAVE の本体の中身のタイミングは画面に出ない

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` の `ResponseSlot`・`COMMAND.READ_SCREEN`・`READ_SCREEN_TO_PRINT(_GRID)` の case・`applyDataStream` の `opts`
- A2: `packages/tn5250/src/session/session.ts` の `applyDataStream` 呼び出しと応答ループ

## design への申し送り
- 応答のレコードを命令の時点で組み、応答ループはそれを送る（無ければ従来どおり今の画面）
