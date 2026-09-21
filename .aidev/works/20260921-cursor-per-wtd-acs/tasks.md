# タスク: カーソルの位置を WTD ごとに決める

## テスト方針
- 単体（分かれたレコード・持ち越し・ホーム・0x40・IC と MC）。実機の 9 画面を ACS と突き合わせる。mutation。

## タスク
- [x] T1: 分かれたレコードの試験画面と、ACS・当 PJ の測定。
      対象: `scripts/build-ulktest.mjs`（SPLIT / SPLITN）、`scripts/acs-probe/read-split-record.txt`、`scripts/verify-read-split-record.mjs`
      依存: なし
      AC: AC1
- [x] T2: IC / MC の持ち越しと WTD の終わりの置き方。READ で動かさない。
      対象: `wtd-applier.ts` `placeCursorAfterWtd`、`buffer.ts` `icAddr` `homeAddr`、`session.ts`
      依存: T1
      AC: AC1
- [x] T3: 9 画面の突き合わせ（DSPFMT は中継で ACS 側のレコードも採った）。
      対象: `scripts/acs-probe/cursor-screens.txt`、`scripts/verify-cursor-screens.mjs`
      依存: T2
      AC: AC2
- [x] T4: テストの書き換え・追加と mutation。
      対象: `cursor-default.test.ts` `cursor-per-wtd.test.ts` `cursor-split-record.test.ts`
      依存: T2
      AC: AC3
