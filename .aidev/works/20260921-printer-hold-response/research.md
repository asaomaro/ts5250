# 調査: ACS のプリンターの応答と障害

## 判明した事実
- F1（原典）: `PSNVT5250P.endOfRecord`（データのレコードの終わり）→ `sendPrintData(true)`: 印刷中でなければ印刷先を開き（`pd.openPrinter`）、
  書いてから `pd.endOfRecord` で応答（`DS5250P.endOfRecord` は `response_string` が NO_ERROR か CLEAR_PROCESSED のときだけ送る）。
  書けなければ `processPrinterError`: 打鍵を解き、`printer_error` を立てて `wait()` で利用者の応答を待つ。**再試行**（63661）は応答を NO_ERROR にして
  書き直し、**取消**（63663）は `cancelPrintJob`（応答を NO_ERROR にし、印刷を捨て、以後のデータを捨てる）。待っている間は応答を送らない。
- F2（原典）: `DS5250P.processClear` は CLEAR_PROCESSED を応答にして `sendEOJ`（印刷中のジョブを閉じる）。
- F3（実機・core。`scripts/verify-printer-hold.mjs`・PUB400・2 回）: 帳票の応答を 5 秒・30 秒止めている間、スプールは **WTR** のまま残り、接続も切れない。
  応答して 5 秒後にスプールは消えた（SAVE(*NO)）。2 本目も同じ。ENDWTR *IMMED は PUB400 では権限が無く試せない（止めている間のホストの取消は未確認）。
- F4（当 PJ）: `printer-session.ts` はジョブの終わりで帳票を確定してすぐ応答。サーバーの `deliverReport` は受信の記録と出力（`handleReport`）を並べて走らせ、
  失敗は警告と状態（`SpoolOutputStatus`）で画面に出すだけ。出力はジョブの終わりにまとめて行う。
- F5（原典・節目の点検のあと）: `PSNVT5250P.closePrinterIfRequired` は `pd.closePrinter()` の IOException を記録するだけで `processPrinterError` に入らない。
  `processClear` → `sendEOJ` → `closePrinterIfRequired`。再試行・取消の応答はどちらも `setResponse(0, 0)`（NO_ERROR）。
- F6（実機・core。`scripts/verify-printer-hold-drop.mjs`・PUB400・2 回）: 応答を止めている間 **WTR**、プリンターを切断すると 10 秒・30 秒とも **RDY**（印刷済みにならない）。
  同じ装置名で繋ぎ直すと書き出しプログラムが起動し、スプールは **MSGW**（用紙の問い合わせ）。1 回目は答えずに 60 秒待って届かず、2 回目は `I` と答えると
  **送り直されて**届き、応答するとスプールは消えた。
