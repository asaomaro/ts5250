# 計画: サーバー側 PDF/蓄積/印刷/DL
## 順序
1. server に pdfkit 依存追加（済）＋ `pdf.ts`（renderSpoolPdf）。単体（%PDF・ページ数・DBCS）。
2. `printer-output.ts`（handleReport: 蓄積＋印刷）。単体（tmp 書込・lp 不在 degrade）。
3. profile schema に printer 設定＋resolve。session-manager/ws-handler で report 時に handleReport 実行。
4. MCP `get_spool_pdf`＋HTTP `/api/spool/:id/:spool/pdf`。単体。
5. web-ui PrinterPane に「PDF ダウンロード」。
6. docs（README/scripts）＋既知の制約更新。
## テスト方針
単体中心（pdfkit は Node で走る）。lp は環境不在のため no-op 検証。実機は不要（生成物はホスト非依存）。
既存テスト green を維持（回帰なし）。
