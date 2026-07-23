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
  /**
   * 受信データがホスト変換済みの印刷データか（HPT）。
   *
   * true なら**受信したバイト列をそのままプリンターへ流す**（`lp -o raw`）。
   * ホストが決めた書式・フォント・改ページのまま印刷される＝本来の印刷経路。
   * false（既定）は帳票を PDF へ起こして印刷する——当アプリの再現なので体裁は元と異なる。
   */
  rawPrint?: boolean;
}

export interface HandleReportResult {
  /** PDF を保存できたときの保存先 */
  pdfPath?: string;
  /** PDF 保存に失敗した理由（UI へ出す。warn も従来どおり呼ぶ） */
  pdfError?: string;
  /** 印刷を投げられたか */
  printed?: boolean;
  /** 送信先プリンター名（autoPrint 設定時） */
  printer?: string;
  /** 印刷に失敗した理由 */
  printError?: string;
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
  if (cfg.autoPrint) result.printer = cfg.autoPrint;

  // ホスト変換済みなら PDF に起こさない。受信バイトをそのまま流すのが本来の経路
  if (cfg.rawPrint) return printRaw(report, cfg, warn, now, result);

  let pdf: Buffer;
  try {
    pdf = await renderSpoolPdf(report.pages, cfg.pdf, warn);
  } catch (e) {
    const msg = `PDF 生成に失敗: ${e instanceof Error ? e.message : String(e)}`;
    warn(msg);
    // 生成に失敗したので保存も印刷もできない。設定されている側に理由を残す
    if (cfg.autoPdfDir) result.pdfError = msg;
    if (cfg.autoPrint) {
      result.printed = false;
      result.printError = msg;
    }
    return result;
  }

  if (cfg.autoPdfDir) {
    const path = join(cfg.autoPdfDir, `${stamp(now())}-${sanitize(report.id)}.pdf`);
    try {
      await writeFile(path, pdf);
      result.pdfPath = path;
    } catch (e) {
      const msg = `PDF 保存に失敗（${cfg.autoPdfDir}）: ${e instanceof Error ? e.message : String(e)}`;
      warn(msg);
      result.pdfError = msg;
    }
  }

  if (cfg.autoPrint) {
    const tmp = join(tmpdir(), `spool-${sanitize(report.id)}-${now()}.pdf`);
    try {
      await writeFile(tmp, pdf);
      const r = await lpPrint(cfg.autoPrint, tmp, warn);
      result.printed = r.ok;
      if (!r.ok && r.error !== undefined) result.printError = r.error;
    } catch (e) {
      const msg = `自動印刷の準備に失敗: ${e instanceof Error ? e.message : String(e)}`;
      warn(msg);
      result.printed = false;
      result.printError = msg;
    }
  }
  return result;
}

/**
 * ホスト変換済みの印刷データをそのまま流す（本来の印刷経路）。
 *
 * PDF には起こさない——中身はプリンターの言語（PCL 等）で、当アプリは解釈しない。
 * `autoPdfDir` が設定されていても PDF は作れないので、理由を残してスキップする。
 */
async function printRaw(
  report: SpoolReport,
  cfg: PrinterOutputConfig,
  warn: (msg: string) => void,
  now: () => number,
  result: HandleReportResult
): Promise<HandleReportResult> {
  if (cfg.autoPdfDir) {
    result.pdfError = "ホスト変換済みの印刷データは PDF にできません（印刷はそのまま流します）";
  }
  if (!cfg.autoPrint) return result;
  const tmp = join(tmpdir(), `spool-${sanitize(report.id)}-${now()}.prn`);
  try {
    await writeFile(tmp, report.raw);
    const r = await lpPrint(cfg.autoPrint, tmp, warn, true);
    result.printed = r.ok;
    if (!r.ok && r.error !== undefined) result.printError = r.error;
  } catch (e) {
    const msg = `自動印刷の準備に失敗: ${e instanceof Error ? e.message : String(e)}`;
    warn(msg);
    result.printed = false;
    result.printError = msg;
  }
  return result;
}

/** `lp -d <printer> <file>` で印刷。lp 不在・失敗は warn して失敗理由を返す（degrade）。 */
function lpPrint(
  printer: string,
  file: string,
  warn: (msg: string) => void,
  /** 変換せずそのまま流す（ホスト変換済みの印刷データ用） */
  raw = false
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // -o raw を付けないと CUPS がフィルターを掛けてしまい、ホストが作った書式が壊れる
    const args = raw ? ["-d", printer, "-o", "raw", file] : ["-d", printer, file];
    const proc = spawn("lp", args, { stdio: "ignore" });
    proc.on("error", (e) => {
      const msg = `自動印刷に失敗（lp が無い可能性）: ${e.message}`;
      warn(msg);
      resolve({ ok: false, error: msg });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const msg = `lp が異常終了しました（code ${code}）`;
        warn(msg);
        resolve({ ok: false, error: msg });
        return;
      }
      resolve({ ok: true });
    });
  });
}
