# タスク: サーバー側 PDF/蓄積/印刷/DL
- [x] P1: server 依存に pdfkit、`pdf.ts` renderSpoolPdf（等幅・DBCS・改ページ・フォント fallback）＋単体
- [x] P2: `printer-output.ts` handleReport（autoPdfDir 蓄積・autoPrint 印刷・degrade）＋単体
- [x] P3: profile schema に printer 設定＋resolvePrinterOutput（server 由来のみ）
- [x] P4: report 受信時に handleReport 実行（session-manager/ws-handler 連携）
- [x] P5: MCP get_spool_pdf（base64）＋HTTP GET /api/spool/:sessionId/:spoolId/pdf ＋単体
- [ ] P6: web-ui PrinterPane に「PDF ダウンロード」ボタン
- [ ] P7: docs（README/scripts）・既知の制約更新
