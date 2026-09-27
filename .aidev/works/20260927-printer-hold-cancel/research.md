# 調査: プリンターの応答を止めている間にホストが帳票を取り消したとき

## 調査の問い
- Q1: 止めている間に HLDSPLF *IMMED / ENDWTR *IMMED をすると、ホストは何を送り、スプールはどうなるか（実測）
- Q2: 応答を解いた後、当 PJ は何を返すか。ACS は同じか（原典）
- Q3: 取り消しの後に届くレコードで、余計な帳票（白紙）ができないか
- Q4: 止めたまま 15 分を超えて待つと接続は切れるか

## 判明した事実
- F0（前提・実測。2026-09-27・社内機）: 繋ぐとホストは書き出しプログラムを自動で起こす（`STRPRTWTR` は CPF3310＝既に開始）。既定の書式では用紙の問い合わせ（CPA3394）、最初のファイルでは位置合わせの問い合わせ（CPA4044。QSYSOPR）で MSGW になり、帳票が届かない。
  測定では `ENDWTR` → `STRPRTWTR FORMTYPE(*ALL *NOMSG)` で起こし直し、CPA4044 に I（続行）で答えた（`scripts/verify-printer-hold-cancel.mjs`）。スプールは利用者のスプール用のジョブ（QPRTJOB）に付くので、`JOB(*)` では指せない。
- F1（Q1・実測）: 帳票（DSPLIBL）がジョブの終わりまで届き、終わりの応答を止めた状態（スプール WRITER・書き出し PRTW）で取り消すと、**ホストは応答を待たずに**、13〜36 ms のうちに
  CLEAR（opcode 2）とフラグ 0x18 の opcode 1（17 バイト）を送ってきた（どちらも止めている間なので当 PJ は溜めた）。
  - HLDSPLF *IMMED: スプールは直ちに **HELD**。書き出しプログラムは PRTW のまま。
  - ENDWTR *IMMED: スプールは直ちに **READY**（待ち行列に戻る）。書き出しプログラムは終わる（END）。
  - どちらも接続は切れない。**帳票は失われない**（印刷済みにならない）。
- F2（Q2・実測。3 回・2 通りとも同じ）: 応答を解くと、当 PJ は止めていた終わりの応答（NO_ERROR）→ 溜めた CLEAR に CLEAR_PROCESSED → 0x18 のレコードに NO_ERROR を順に返し、
  **解いた後に新たに届いた 2 本目の CLEAR**（取り消しの後の 3 本目のレコード）（止めている間には来ていない——3 回目の測定で「解いた後に新たに届いたレコード」として確かめた）に CLEAR_PROCESSED を返した。解いた後もスプールは HELD / READY のまま。
- F3（Q2・原典 `PSNVT5250P.processPrinterError`）: ACS は印刷先の障害でデータ処理のスレッドを `wait()` で止め、利用者の再試行・取消を待つ（その間の受信レコードは処理されない＝当 PJ が溜めるのと同じ）。
  取消（`cancelPrintJob`）は応答を `responses[0]`＝NO_ERROR にしてジョブを捨て、再試行は NO_ERROR で続ける。**どちらも NO_ERROR**——当 PJ が解いたときに NO_ERROR を返すのと同じ。
- F4（Q3・原典 `DS5250P.processScs`）: ACS はフラグ 1（ヘッダのバイト 7）が**ちょうど 8** で本体が空か 0x00 だけのときだけジョブの終わり（`sendEOJ`）とし、それ以外は SCS のデータとして足す（`setSCSData`）。当 PJ も同じ判定（`printer-session.ts` の `endOfJob`）。
  0x18 のレコードはどちらもデータとして扱う。
- F5（Q3・実測。2 回目）: 取り消しの後のフラグ 0x18 の opcode 1 のレコード（17 バイト）の本体は **0x0C（FF）の 1 バイト**。当 PJ はこれをデータとして新しいジョブに足し、続く CLEAR でそのジョブを閉じて
  **`cleared: true`・raw 1 バイト・ページ 0 の帳票**を出した（HLDSPLF・ENDWTR とも同じ）。サーバーは CLEAR で閉じた帳票も出力する（`packages/server/src/session-manager.ts` の `outputGate`）ので、
  自動 PDF があれば**白紙 1 ページの PDF**になる（`packages/server/src/pdf.ts` はページが 0 なら空のページを 1 枚置く）。自動印刷なら白紙を印刷しうる。
- F6（Q3・原典 `PSNVT5250P.setSCSData` / `sendEOJ` と出力の先）: ACS も FF をデータとして溜めて印刷を始め（`setStartPrint(true)`→`endOfRecord`→`sendPrintData` でプリンターを開いて書く）、CLEAR の `sendEOJ` でジョブを閉じる。
  出力は経路で分かれる（`PD5250`: `jpsUse` の既定は true＝JPS が既定）:
  - **JPS（既定）**: `PrintSCS5250JPS.processFormFeed` は FF でその時点のコマンド列を 1 ページとして足し、閉じるときに `printerJob.print()` がページを描く——**FF だけのジョブは白紙 1 ページ**。当 PJ の白紙 1 ページの PDF と一致する。
  - PDT: `PrintSCS5250.processFormFeed` は最初の FF を保留し（`FFpending`）、後にデータが続くか PDT の「ジョブの終わりで改ページ」が HOST のときだけ送る——FF 1 バイトだけなら用紙を送らない可能性がある。
  ACS の実際の出力は実測していない（`com.ibm.eNetwork.ECL.ECLHostPrintSession` で ACS のプリンターのコアを当てられるかは**未確認**——試していない）。
- F7（Q4・実測。2026-09-27・社内機）: 帳票の終わりの応答を止めたまま **17 分**待っても、接続は切れず（`closed` 無し）、スプールは WRITER・書き出しプログラムは PRTW のまま。解くとスプールは印刷済みになって消えた。

## 影響範囲
- `packages/tn5250/src/session/printer-session.ts`（止めている間の溜め・CLEAR）・`packages/server/src/session-manager.ts`（`outputGate`）・`packages/server/src/pdf.ts`

## 実現性 / リスク
- 当 PJ の応答は ACS と同じ（F2・F3）。帳票は失われない（F1・F7）。差があり得るのは F5 の FF だけのジョブ（白紙）で、ACS の実際の出力が測れないため判断を要する。

## 実装アンカー
- A1: 止めている間に溜めて解いた後に処理する（`printer-session.ts` の `onRecord` / `held`）
- A2: 既存の試験（`packages/tn5250/test/printer-session.test.ts` の describe「respondAfter」）

## design への申し送り
- 実測した並び（止めている間に CLEAR ＋ FF のレコード ＋ CLEAR）を単体テストで固定する。
- FF だけの帳票（白紙）の扱いは backlog に要判断として残す（ACS の出力を測る手段ができたら決める）。
