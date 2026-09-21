# 設計: 測定の道具

## 概要
- DDS の表示装置ファイル UNIDSPF（レコード UNIREC: A 型・G 型 CCSID(13488)・G 型 CCSID(1200)・G 型 CCSID 無し）と、ILE C の UNITST（レコードを 1 回出して入力の生バイトをログへ残す）を、既存の QDDSSRC に入れて作る。
  当 PJ は `traceRecords` で受信レコードの生バイトを出し、ACS のコアは `dump` で画面を出す。

## 対象範囲
- `scripts/` の道具だけ。製品のコードは変えない。

## 依拠する既存の事実
- `scripts/build-ulktest.mjs`（DDS を QDDSSRC に入れて CRTDSPF）・`scripts/build-dscmd.mjs`（C を IFS に置いて CRTBNDC。`SYSIFCOPT(*IFSIO)` が要る）・`scripts/diag-5250-commands.mjs`（`traceRecords`）の作りを踏襲した。

## インターフェース / データ構造
- `node scripts/build-unitest.mjs [--clean]`・`node scripts/diag-unifield.mjs [SBA]`・`scripts/acs-probe/unicode-field.txt`。

## 振る舞いの詳細
- 測定後は `--clean` で UNITST・UNIDSPF・ソースのメンバー・IFS のソースとログを消し、CHKOBJ で無いことを確かめる。

## エラー処理 / 異常系
- CRTBNDC は失敗しても戻りコード 0 で返ることがあるので、メッセージと CHKOBJ で確かめる。

## 受け入れ基準との対応
- AC1: 3 本の道具。AC2: research に測定結果、台帳に書く。AC3: 台帳の訂正と `--clean` の確認。
