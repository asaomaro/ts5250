# 要件: 起動応答 I901・I902 以外のコード（I906・表に無いコード）の扱いを ACS と突き合わせて決める

## 背景 / 課題
`.aidev/backlog/acs-parity.md` の「起動応答 I901・I902 以外のコードの扱い」。ACS `DS5250.processStartUpConfirmation` は I901・I902 と
表に無いコードでは開始の処理（装置名の設定・状態 7・5）に進まない。当 PJ は I906 と、装置名が空でない表に無いコードを成功扱いで開く
（`packages/tn5250/src/telnet/startup-codes.ts` の `STARTUP_SUCCESS_CODES`・`packages/tn5250/src/session/session.ts`）。
ACS が I906 でどう振る舞うかは実機で測っていない（未確認）。

## 目的 / ゴール
I906・表に無いコードを受けたときの当 PJ の振る舞いが、ACS の原典・実測に照らして「合わせる／合わせない（理由つき）」のどちらかに決まり、
テストで固定されている状態。実機で確かめられないことは「未確認」と明記されている。

## ユーザーストーリー
- US1: 当 PJ の利用者として、自動サインオンが許されない環境でもサインオン画面が出て操作を続けたい。なぜなら ACS でもサインオン画面が続くから。（受け入れ: AC1, AC2）

## スコープ
### 対象
- ACS の原典（`DS5250.processStartUpConfirmation` / `processDiagnosticInformation` / `processPassthru`・`ECLSession.SetWorkstationID`）の読み
- I906 を実機で出させる試み（ACS のコア・当 PJ の両方）
- 決めた扱いの単体テスト

### 対象外
- 8xxx 等の失敗コードの扱い（既に `SESSION_REJECTED` で閉じている）
- 起動応答の文言表示（`20260921-startup-code-status` で済み）

## 機能要件
- I906・装置名の入った表に無いコードを受けても、続く画面（サインオン画面）を処理してセッションを続ける。
- 装置名の扱いは ACS と比べて決め、理由を decisions に残す。

## 非機能要件 / 制約
- ホストのシステム値（QRMTSIGN 等）は変えない（共有の実機）。

## 完了条件 (受け入れ基準)
- [ ] AC1: I906 の起動応答の後に届く画面を処理し、セッションが開いたままである（単体テスト）
- [ ] AC2: 装置名の入った表に無いコードでも AC1 と同じ（単体テスト）
- [ ] AC3: I906 を実機で出させる試みの結果（出せた／出せなかった・その理由）が research に残り、出せない場合は「未確認」が backlog に明記される
- [ ] AC4: 装置名を採る／採らないの決定が decisions に原典の根拠つきで残る

## 未確認事項 / 確認したいこと
- どの条件で I906 が返るか（QRMTSIGN *FRCSIGNON で返ると見込んでいる）——research で確かめる
