import PDFDocument from "pdfkit";
import type { LogicalPage } from "@ts5250/scs";
import { displayableChar, overGlyphView, ruleLook } from "@ts5250/scs";
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


/** 罫線を引く（二重は 2 本の細線を 1.2 pt 離す。点線は 7.2 pt の破線。ACS `JPSGridLine`） */
function strokeLine(doc: PDFKit.PDFDocument, x1: number, y1: number, x2: number, y2: number, width: number, dotted: boolean, pair: boolean): void {
  const draw = (dx: number, dy: number): void => {
    doc.save();
    doc.lineWidth(width);
    if (dotted) doc.dash(7.2 * 0.4, { space: 7.2 * 0.4 });
    doc.moveTo(x1 + dx, y1 + dy).lineTo(x2 + dx, y2 + dy).stroke();
    doc.restore();
  };
  if (pair) {
    const horizontal = y1 === y2;
    draw(horizontal ? 0 : -0.6, horizontal ? -0.6 : 0);
    draw(horizontal ? 0 : 0.6, horizontal ? 0.6 : 0);
  } else draw(0, 0);
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
    // 桁の幅（等幅なので半角 1 字の幅）。重ねて描く字・罫線の位置に使う
    const cw = doc.widthOfString("M");
    for (const [r, line] of page.lines.entries()) {
      // **描けない字は半角スペースへ**（HTML・画面と同じ扱い。`displayableChar`）。
      // 復号コードページにマップの無いバイトはコーデックが U+FFFD で返すので、
      // 素通しすると紙に `◆` が混ざる——しかも多くのフォントで全角幅なので桁までずれる。
      const text = [...line].map(displayableChar).join("");
      // lineBreak:false で折り返さず 1 行として描く（等幅フォントで桁が揃う）
      doc.text(text.length > 0 ? text : " ", margin, y, { lineBreak: false });
      // **格子に載らないもの**（重ね打ちで下になった字・半分の幅の字・罫線。`LogicalPage.decor`）を重ねて描く（画面・HTML と同じ位置。行の箱は `lineHeight`）
      const d = page.decor?.[r];
      if (d) {
        for (const g of d.glyphs ?? []) {
          const v = overGlyphView(g);
          doc.save();
          doc.translate(margin + g.x * cw, y);
          if (v.scale !== 1) doc.scale(v.scale, 1);
          doc.text(v.text, 0, 0, { lineBreak: false });
          doc.restore();
        }
        for (const h of d.h ?? []) {
          const l = ruleLook(h);
          strokeLine(doc, margin + h.x1 * cw, y + lineHeight, margin + h.x2 * cw, y + lineHeight, l.pt, h.dotted, h.weight === "pair");
        }
        for (const v of d.v ?? []) {
          const l = ruleLook(v);
          strokeLine(doc, margin + v.x * cw, y, margin + v.x * cw, y + lineHeight, l.pt, v.dotted, v.weight === "pair");
        }
      }
      y += lineHeight;
    }
  }
  doc.end();
  return done;
}
