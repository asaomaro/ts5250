import PDFDocument from "pdfkit";
import type { LogicalPage } from "@as400web/core";

/**
 * 論理ページ（等幅グリッド）→ PDF。等幅フォントで各行を描画し、ページ＝改ページ。
 * 既定は Noto Sans Mono CJK JP（Latin 半角＋日本語全角を 1 フォントで等幅に賄う。DBCS 対応）。
 * フォントを読めない場合は標準 Courier にフォールバックする（SBCS のみ・DBCS は化ける）。
 */

export interface PdfOptions {
  /** 埋め込むフォントのパス（TTF/OTF/TTC）。省略時は Noto Sans Mono CJK */
  fontPath?: string;
  /** .ttc コレクションから選ぶ postscript 名（例 NotoSansMonoCJKjp-Regular） */
  fontName?: string;
  /** フォントサイズ（pt）。既定 8（132 桁でも LETTER に収まる） */
  fontSize?: number;
  /** ページサイズ（pdfkit 準拠。既定 LETTER） */
  pageSize?: string;
  /** 余白（pt）。既定 36 */
  margin?: number;
}

const DEFAULT_FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const DEFAULT_FONT_NAME = "NotoSansMonoCJKjp-Regular";

export function renderSpoolPdf(
  pages: LogicalPage[],
  opts: PdfOptions = {},
  warn?: (msg: string) => void
): Promise<Buffer> {
  const fontSize = opts.fontSize ?? 8;
  const margin = opts.margin ?? 36;
  const pageSize = opts.pageSize ?? "LETTER";

  const doc = new PDFDocument({ size: pageSize, margin, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // 等幅 CJK フォント（失敗時は Courier）
  try {
    doc.registerFont("mono", opts.fontPath ?? DEFAULT_FONT_PATH, opts.fontName ?? DEFAULT_FONT_NAME);
    doc.font("mono");
  } catch (e) {
    doc.font("Courier");
    warn?.(`CJK フォントを読めませんでした（DBCS は文字化けの可能性）: ${e instanceof Error ? e.message : e}`);
  }
  doc.fontSize(fontSize);
  const lineHeight = fontSize * 1.2;

  const list = pages.length > 0 ? pages : [{ rows: 1, cols: 1, lines: [""] }];
  for (const page of list) {
    doc.addPage();
    let y = margin;
    for (const line of page.lines) {
      // lineBreak:false で折り返さず 1 行として描く（等幅フォントで桁が揃う）
      doc.text(line.length > 0 ? line : " ", margin, y, { lineBreak: false });
      y += lineHeight;
    }
  }
  doc.end();
  return done;
}
