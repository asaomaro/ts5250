import PDFDocument from "pdfkit";
import type { LogicalPage } from "@ts5250/scs";
import { candidateFontPaths, findMonoCjkFont } from "./pdf-font.js";

/**
 * 論理ページ（等幅グリッド）→ PDF。等幅フォントで各行を描画し、ページ＝改ページ。
 *
 * 埋め込むフォントは**システムから探す**（`pdf-font.ts`）。Linux は Noto Sans Mono CJK、
 * Windows は MS ゴシック等。パスを 1 本焼き込んでいたため、Windows では
 * `C:\usr\share\fonts\…` を探しに行って必ず失敗していた（利用者の報告）。
 * 見つからない場合は標準 Courier にフォールバックする（SBCS のみ・DBCS は化ける）。
 */

export interface PdfOptions {
  /** 埋め込むフォントのパス（TTF/OTF/TTC）。省略時はシステムから探す（`pdf-font.ts`） */
  fontPath?: string;
  /** .ttc コレクションから選ぶ postscript 名（例 `MS-Gothic` / `NotoSansMonoCJKjp-Regular`） */
  fontName?: string;
  /** フォントサイズ（pt）。既定 8（132 桁でも LETTER に収まる） */
  fontSize?: number;
  /** ページサイズ（pdfkit 準拠。既定 LETTER） */
  pageSize?: string;
  /** 余白（pt）。既定 36 */
  margin?: number;
}


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

  // 等幅 CJK フォント（失敗時は Courier）。
  // **明示指定が最優先**、無ければシステムから探す（`pdf-font.ts`）
  const found = opts.fontPath ? { path: opts.fontPath, face: opts.fontName } : findMonoCjkFont();
  if (found) {
    try {
      doc.registerFont("mono", found.path, found.face);
      doc.font("mono");
    } catch (e) {
      doc.font("Courier");
      warn?.(`CJK フォントを読めませんでした（DBCS は文字化けの可能性）: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    doc.font("Courier");
    // **どこを探したかを出す**。無いのか、探し先が違うのかを利用者が切り分けられるように
    warn?.(
      "等幅の CJK フォントが見つかりませんでした（DBCS は文字化けの可能性）。" +
        `探した場所: ${candidateFontPaths().join(" / ")}`
    );
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
