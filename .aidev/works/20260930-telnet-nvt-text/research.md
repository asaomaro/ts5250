# 調査: ACS の NVT のテキスト処理

## 判明した事実
- F1（原典 `NVT5250.process_outbound`・`NVT.NVT_process_outbound`）: `optstate[0]`（BINARY）か `optstate[25]`（EOR）が成立していれば 5250 のレコード、そうでなければ NVT のテキストとして、合成した WTD（`04 11 00 08` ＋ SBA ＋ 本文 ＋ IC）を出力専用のレコード（オペコード 2）にして流す。テキストの塊は IAC のコマンドの手前と受信の終わりで区切る（`Telnet.receive`）。
- F2（原典）: 0x20〜0x7E は固定の EBCDIC の表で書いて桁を 1 進め、NUL・その他の制御文字・0x7F 以上は無視。BS は 1 桁戻って SBA。0x05 は次の 8 桁の境目まで空白。CR は行頭へ。LF・VT・FF は 1 行下（桁は同じ）へ移り、その行を空白で埋める。HT（0x09）は書かれていない＝無視。
- F3（実測。偽のサーバー〔`scripts/fake-nvt-server.mjs`〕を ACS のコアに当てた。`scripts/acs-probe/nvt-text.txt`・`PROBE_CODEPAGE=37`）: 9 通りの画面・カーソルは原典の読みどおり。LF はスクロールせず、24 回で 1 行目へ回り込み行を空白で埋める（`a`＋LF×24＋`Q` は 1 行目が ` Q`）。`! [ ] ^ |` の表は 037 と違い、`!` は画面で `|` に見える。先頭の BS は SBA 1,0 になり ACS が否定応答（1005 0122）で受信ぶんを捨てる。
- F4（実測）: 画面の終わりを越えて書く受信は全部捨てられ、ACS は入力禁止のまま以降の受信も書かなくなる。Reset を 14 回押しても戻らない。
- F5（バックアップホストの調査。`decisions D1`）: ACS のコアは `hostBackup1/2`・`portBackup1/2` を持ち、接続の時間切れで次のホストへ移る（`ECLConnection`・`Transport`）が、ACS の利用者向けの設定画面（`com/ibm/eNetwork/HOD/acs` の 182 クラス）に `hostBackup`・`portBackup`・`backup` の参照は 1 つも無い。
- F6（当 PJ の差）: `TelnetLayer` は通常データを `record` へ溜めて IAC EOR まで待つだけで、EOR が来ないテキストは永久に画面へ出ない。

## 実装アンカー
- A1: `packages/tn5250/src/telnet/telnet.ts`（`feed`・`handleIac`・`handleOptNeg`）
- A2: `packages/tn5250/src/telnet/nvt-text.ts`（新規）
- A3: `packages/tn5250/src/session/session.ts`（`establish`・`handleNvtText`）
