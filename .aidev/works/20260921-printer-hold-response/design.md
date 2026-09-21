# 仕様: 出力に失敗したら応答を止める

## 設計方針
- コア: `PrinterConnectOptions.respondAfter(report)` を足す。帳票を確定したレコード（ジョブの終わり・CLEAR）の応答は、返った Promise が解決（拒否でも）してから送る。
  待っている間に届いたレコードは溜め、応答のあとに順に処理する。
- サーバー: `openPrinter` が `respondAfter` に `outputGate` を渡す。自動出力が無い・OFF なら待たない。あれば `runOutputs` で出力し、失敗したら
  `heldOutput`（帳票・失敗した出力だけの設定・応答の関数）に置いて状態に `held` を立てる。`retryPrinterOutput` はそれで出力し直し、`cancelPrinterOutput` は
  `canceled` を記録して応答する。接続が切れたら手放す。telnet で届いた帳票は `deliverReport` では出力しない（`gated`）。救出は従来どおり。
- ws: `printer-output-retry` / `printer-output-cancel`（開いているプリンターセッション）。状態に `held` / `canceled`。
- web-ui: 止めている状態があれば上部にバー（`MSG_PRINTER_HELD`）と再試行・取消のボタン。一覧の行と詳細にも出す。

## 依拠する既存の事実
- 出力の関数 `handleReport` は保存先のディレクトリを作らない（無ければ失敗）。権限は自動出力の切り替えと同じ `getPrinter`（所有者/admin）。

## 受け入れ基準との対応
- AC1: `printer-session.test.ts`（respondAfter 5 件）・`printer-hold-response.test.ts`。AC2: 同。AC3: `printer-pane-held.test.ts` と
  `scripts/verify-printer-hold-server.mjs`（PUB400）。AC4: mutation。
