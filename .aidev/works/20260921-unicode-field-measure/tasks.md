# タスク: Unicode の欄の実機測定

## テスト方針
- 実機の測定（コード変更なし）。生バイトと画面の記録を台帳・decisions に残す。

## タスク
- [x] T1: 測定の道具を作り、実機で測る（当 PJ・ACS のコア）。
      対象: `scripts/build-unitest.mjs` `scripts/diag-unifield.mjs` `scripts/host-src/unitst.c` `scripts/acs-probe/unicode-field.txt` / 根拠: research A1
      依存: なし
      AC: AC1, AC2
- [x] T2: 台帳を直し、試験オブジェクトを片付ける。
      対象: `.aidev/backlog/acs-parity.md` / 根拠: research F1・F2
      依存: T1
      AC: AC3
