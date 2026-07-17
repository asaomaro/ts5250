import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { SpoolReport } from "@as400web/core";
import { renderSpoolPdf, type PdfOptions } from "./pdf.js";

/**
 * プリンターセッションの受信スプールに対するサーバー側処理（PDF 自動蓄積・物理自動印刷）。
 * 設定は**プロファイル由来のみ**（ブラウザ直指定は受けない）。出力先・プリンターは信頼された値とする。
 */
export interface PrinterOutputConfig {
  /** 受信ごとに PDF を貯めるディレクトリ（プロファイル設定） */
  autoPdfDir?: string;
  /** 受信ごとに自動印刷するプリンター名（lp -d の宛先） */
  autoPrint?: string;
  /** PDF 生成オプション（フォント・サイズ等） */
  pdf?: PdfOptions;
}

export interface HandleReportResult {
  pdfPath?: string;
  printed?: boolean;
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 受信スプールを設定に従って PDF 保存／印刷する。autoPdfDir も autoPrint も無ければ何もしない。
 * 失敗は warn して継続（機能を degrade。受信自体は妨げない）。
 */
export async function handleReport(
  report: SpoolReport,
  cfg: PrinterOutputConfig,
  warn: (msg: string) => void = () => {},
  now: () => number = () => Date.now()
): Promise<HandleReportResult> {
  if (!cfg.autoPdfDir && !cfg.autoPrint) return {};
  const result: HandleReportResult = {};
  let pdf: Buffer;
  try {
    pdf = await renderSpoolPdf(report.pages, cfg.pdf, warn);
  } catch (e) {
    warn(`PDF 生成に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  if (cfg.autoPdfDir) {
    const path = join(cfg.autoPdfDir, `${stamp(now())}-${sanitize(report.id)}.pdf`);
    try {
      await writeFile(path, pdf);
      result.pdfPath = path;
    } catch (e) {
      warn(`PDF 保存に失敗（${cfg.autoPdfDir}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (cfg.autoPrint) {
    const tmp = join(tmpdir(), `spool-${sanitize(report.id)}-${now()}.pdf`);
    try {
      await writeFile(tmp, pdf);
      result.printed = await lpPrint(cfg.autoPrint, tmp, warn);
    } catch (e) {
      warn(`自動印刷の準備に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/** `lp -d <printer> <file>` で印刷。lp 不在・失敗は warn して false（degrade）。 */
function lpPrint(printer: string, file: string, warn: (msg: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("lp", ["-d", printer, file], { stdio: "ignore" });
    proc.on("error", (e) => {
      warn(`自動印刷に失敗（lp が無い可能性）: ${e.message}`);
      resolve(false);
    });
    proc.on("close", (code) => {
      if (code !== 0) warn(`lp が異常終了しました（code ${code}）`);
      resolve(code === 0);
    });
  });
}
