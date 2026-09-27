# 仕様: 起動応答 I901・I902 以外のコードの扱い

## 概要
振る舞いは変えない（decisions D1）。I906・装置名の入った表に無いコードで「サインオン画面を処理して続け、装置名を採る」ことを単体テストで固定し、ACS の測定資産を残す。

## 設計方針
ACS もセッションを続ける（research F3）ので合わせる必要は無い。装置名を採らない ACS には情報を捨てるので合わせない（D1）。

## 対象範囲
- テスト: `packages/tn5250/test/session.test.ts` の「起動応答レコード」に I906・未知コード（装置名つき）の 2 件（既存の `startupResponseRecord()` の先頭 4 バイトだけ差し替え、`signonEntries()` を続ける）
- 測定資産: `scripts/acs-probe/AcsProbe.java` の dump に起動応答のコード（先頭 4 字）・装置名・`wsidReady`、`scripts/acs-probe/startup-i906.txt`（新規）
- コメント: `packages/tn5250/src/telnet/startup-codes.ts` の `STARTUP_SUCCESS_CODES` に ACS との関係（D1）を書く
- 台帳: deliver で消し込み、I906 の実機での見え方の未確認を残す

## 依拠する既存の事実
- 1 レコード目の分岐（`packages/tn5250/src/session/session.ts` の `startup && (isKnownStartupCode(startup.code) || startup.device !== "")`）: 既知のコードか装置名つきなら `startupInfo` に採り、成功の表に無い既知のコードだけ `SESSION_REJECTED`（research F6）
- `STARTUP_SUCCESS_CODES` に I906 がある（`startup-codes.ts`）
- 試験の段取り: `session.test.ts` の `startupResponseRecord()`（実機 PUB400 の I902 レコード）・`signonEntries()`・`connectReplay`

## インターフェース / データ構造
- 変更なし。`AcsProbe` の dump の 1 行目に ` startup=<4 字> wsid=<装置名> wsidReady=<bool>` が付く

## 振る舞いの詳細
- I906: `session.startup` は `{ code: "I906", system, device }`、画面はサインオン（後ろのレコード）が出る
- 表に無いコード（装置名つき）: 同上

## エラー処理 / 異常系
- 変更なし

## 受け入れ基準との対応
- AC1: session.test.ts の I906 のテスト（入力は合成の起動応答＋実機 PUB400 のサインオンのリプレイ）
- AC2: 同じく表に無いコード `Z123` のテスト
- AC3: research F5 と backlog の未確認
- AC4: decisions D1（原典 `processStartUpConfirmation` / `processDiagnosticInformation` / `SetWorkstationID`）
