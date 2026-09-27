# 調査: WRITE ERROR CODE（0x21）のメッセージの行

## 調査の問い
- Q1: ACS は 0x21 の本文をどの行・どの桁に書くか（SOH の申告あり・なし）。
- Q2: 本文が 1 行より長いときの扱い。
- Q3: 当 PJ の今の振る舞い。

## 判明した事実
- F1（Q1・原典。`DS5250.processWriteErrorCode`。`20260926-window-error-code` research F1 と同じメソッド）: 書き始め＝(SOH のメッセージ行 − 1)×桁数、終わり＝書き始め＋桁数。0x21 では桁の指定が無いので、
  **メッセージ行の 1 行ぶん全部を空にして行頭から書く**。本文の長さの上限はレコードの終わり（0x22 のような上限は無い）。
- F2（Q1・実測。`scripts/acs-probe/wec-msgline-row.txt`・2026-09-27・社内機・930。0x21 は DSM で出させた——`scripts/host-src/dscmd.c` の WEC*）:
  - 申告なし: **24 行**に出た（桁 1 に属性・桁 2 から本文。元の目印は全部消えた）。**ACS の既定は最下行**（requirements の未確認を閉じる）。
  - SOH で 22 を申告: **22 行**に出た。23 行の目印（`NEXT ROW TEXT`）はそのまま。
  - どちらも `inhibit=5`、Reset で元の行が戻った。
- F3（Q2・実測）: 90 字の本文は 22 行の桁 2〜80 に 79 字、**続きの 11 字が 23 行の桁 1〜11 を上書きした**（`BCDEFGHIJKLEXT`）。Reset の後、22 行は戻ったが **23 行は上書きされたまま戻らなかった**
  （ACS が退避・復元するのはメッセージ行の範囲だけ。F1 の終わり＝書き始め＋桁数）。
- F4（Q3・当 PJ）: 0x21 の本文は `systemMessage`（長さの上限なし）で、UI が**最下行に重ねる**（`systemMessageArea` を付けない。`20260926-window-error-code`）。
  メッセージ行を 22 に申告した画面でも 24 行に出る。

## 影響範囲
- core: `packages/tn5250/src/protocol/wtd-applier.ts` の `applyWriteErrorCode`（0x21 のときの位置）。UI は `systemMessageArea` があればそこへ重ねる作りが既にある。

## 実装アンカー
- A1: `applyWriteErrorCode` の `buf.systemMessageArea = win ? windowErrorArea(…) : undefined`（`20260926-window-error-code` で足した行）。
- A2: 既存のテスト `packages/tn5250/test/window-error-code.test.ts` の「0x21 には位置が付かない」（振る舞いが変わるので直す）。

## 実装時の注意
- 0x21 の位置は {行＝メッセージ行, 桁 1, 幅＝桁数}。最下行へ戻す判定は起きない（書き始めが行頭なので）。
- 1 行を超えた続き（F3）は合わせない——decisions D2。

## design への申し送り
- 0x21 にも `systemMessageArea` を付ける。UI はそのまま使える（幅で切れる）。
