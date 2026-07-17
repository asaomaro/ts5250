# 仕様: サーバー側 PDF/蓄積/印刷/DL

## 設計方針
論理ページ（`LogicalPage[]`）→ PDF を server の新モジュール `pdf.ts` で生成（pdfkit＋Noto Sans Mono CJK）。
受信 report 時にプロファイル設定に従い「PDF 自動蓄積」「自動印刷」を実行。DL は HTTP＋MCP でオンデマンド生成。
出力先・プリンターは**プロファイル由来のみ**（ブラウザ直指定は不可＝セキュリティ）。

## インターフェース / データ構造
- `packages/server/src/pdf.ts`:
  ```ts
  interface PdfOptions { font?: string; fontPath?: string; fontSize?: number; pageSize?: string; margin?: number; }
  function renderSpoolPdf(pages: LogicalPage[], opts?: PdfOptions): Promise<Buffer>;
  ```
  等幅で各ページの lines を描画（DBCS 全角=2桁）、FF＝新ページ。フォント欠落時は Courier で SBCS 描画＋warn。
- `packages/server/src/printer-output.ts`（新）:
  ```ts
  interface PrinterOutputConfig { autoPdfDir?: string; autoPrint?: string; pdf?: PdfOptions; }
  async function handleReport(report: SpoolReport, cfg: PrinterOutputConfig, warn): Promise<void>;
  // autoPdfDir があれば <dir>/<yyyymmdd-hhmmss>-<spoolId>.pdf を書く。autoPrint があれば lp -d で印刷（lp 不在は warn）。
  ```
- profile schema 追加: `printer?: { autoPdfDir?, autoPrint?, pdfFont?, pdfFontPath?, pageSize? }`。
  `resolvePrinterOutput(profileName)` で server 側のみ解決。WsOpen/直接接続では無効。
- MCP: `get_spool_pdf(sessionId, spoolId)` -> { base64, bytes }（＋任意で savedPath）。
- HTTP: `GET /api/spool/:sessionId/:spoolId/pdf` -> application/pdf（web-ui のダウンロード用）。
- web-ui PrinterPane: 「PDF ダウンロード」ボタン（上記エンドポイントを fetch → Blob 保存）。

## 振る舞い / セキュリティ
- 受信 report → session が profile 由来の PrinterOutputConfig を持つときのみ蓄積/印刷を実行。
- autoPdfDir はプロファイル値のみ。ファイル名は spoolId とタイムスタンプから生成（パス要素をサニタイズ）。
- autoPrint は `lp -d <printer> <tmp.pdf>`。lp 不在・失敗は warn して継続（機能 degrade）。

## 受け入れ基準との対応
- SBCS/DBCS PDF 生成 → `renderSpoolPdf` の単体テスト（%PDF・非空・複数ページ）。
- 自動蓄積 → `handleReport` の単体（tmp ディレクトリに PDF が書かれる）。
- 自動印刷 → lp 呼び出しの単体（spawn をモック/存在時のみ）。この環境では lp 不在のため no-op 検証。
- DL（HTTP/MCP）→ エンドポイント/ツールが %PDF を返す単体。
