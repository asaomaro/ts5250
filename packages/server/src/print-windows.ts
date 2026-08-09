/**
 * Windows のプリントキューへ印刷する。
 *
 * ## なぜ `lp` ではないのか
 *
 * `lp` は CUPS のコマンドで Windows には無い。そのまま呼んでいたので
 * `spawn lp ENOENT` で必ず失敗していた（利用者の報告）。
 *
 * ## なぜ「9100 直送」でも「PDF を流す」でもないのか
 *
 * - **9100 直送はしない**（利用者の指示）。プリンターがリモートにあり、
 *   アプリの動く機械から直接叩ける前提を置けない。**Windows のキュー経由**なら
 *   ドライバーと資格情報の解決を OS に任せられる。
 * - **PDF はキューへ流せない。** Windows には PDF をプリンターへ投げる標準の CLI が無く、
 *   既定の PDF ハンドラ（Edge）は `print` / `printto` の verb を持たない（実機で確認）。
 *   `print.exe` はテキスト専用、`lpr.exe` は既定で未インストール。
 *
 * ## 何をしているか
 *
 * `System.Drawing.Printing.PrintDocument` で**行を等幅フォントで描いて**キューへ出す。
 * .NET Framework に入っているので追加インストールが要らず、ドライバー経由なので
 * リモートのプリンターでもそのまま出る。スプールはもともと等幅の桁組みなので、
 * PDF に起こしてから印刷するのと中身は同じ。
 *
 * 実機（利用者の Windows）で確認済み:
 * - `Microsoft Print to PDF` へ `PrintToFile` 付きで出すとダイアログ無しで PDF が生成される
 * - `MS Gothic` で日本語も桁も崩れない
 */
import { spawn } from "node:child_process";

/** 改ページ。論理ページの区切りに使う（ホストが決めた改ページをそのまま出す） */
export const PAGE_BREAK = "\f";

/**
 * 印刷スクリプト。**値は環境変数で渡す**——プリンター名やパスを文字列に埋め込むと
 * 引用符の扱いで壊れるし、値によっては別のコマンドとして解釈されうる。
 *
 * `MS Gothic` は日本語 Windows に必ずある等幅フォント（実測で半角 1 : 全角 2）。
 * 無い環境では GDI が既定フォントに落とす——桁は崩れるが印刷自体は通る。
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
# 進捗レコードを止める。標準エラーへ CLIXML で流れ込んで、失敗理由が読めなくなる
$ProgressPreference = 'SilentlyContinue'
# 出力を UTF-8 に。既定はコンソールのコードページ（日本語なら CP932）で、
# 受け取る Node 側が UTF-8 として読むと日本語のエラーが化ける。
# **失敗しても続ける**——ハンドルが繋がっていない環境では設定できないことがあり、
# 化けるのは困るが印刷が止まる方が困る
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try {
Add-Type -AssemblyName System.Drawing
$text = [System.IO.File]::ReadAllText($env:TS5250_FILE, [System.Text.Encoding]::UTF8)
$pages = $text -split "\\f"
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.DocumentName = 'ts5250 spool'
$doc.PrinterSettings.PrinterName = $env:TS5250_PRINTER
if (-not $doc.PrinterSettings.IsValid) { throw ('プリンターが見つかりません: ' + $env:TS5250_PRINTER) }
if ($env:TS5250_OUTFILE) {
  $doc.PrinterSettings.PrintToFile = $true
  $doc.PrinterSettings.PrintFileName = $env:TS5250_OUTFILE
}
$font = New-Object System.Drawing.Font($env:TS5250_FONT, [single]$env:TS5250_SIZE)
$page = 0
$doc.add_PrintPage({
  param($sender, $e)
  $lines = $pages[$page] -split "\\r?\\n"
  $y = [single]$e.MarginBounds.Top
  $lh = $font.GetHeight($e.Graphics)
  foreach ($l in $lines) {
    if ($y + $lh -gt $e.MarginBounds.Bottom) { break }
    if ($l -ne '') { $e.Graphics.DrawString($l, $font, [System.Drawing.Brushes]::Black, [single]$e.MarginBounds.Left, $y) }
    $y += $lh
  }
  $page++
  $e.HasMorePages = ($page -lt $pages.Length)
})
$doc.Print()
} catch {
  # **PowerShell のエラーストリームに流さない。** 流すと呼び出し側には
  # \`#< CLIXML\` という XML の断片しか届かず、原因が分からなくなる（実測）
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export interface WindowsPrintOptions {
  /** キューの名前（`Get-Printer` の Name） */
  printer: string;
  /** 印刷するテキストのパス。改ページは `\f` で区切る */
  file: string;
  /** 等幅フォント名（GDI のファミリー名）。既定 `MS Gothic` */
  font?: string;
  /** フォントサイズ（pt）。既定 8（PDF 側と合わせる） */
  size?: number;
  /** ファイルへ出す（`Microsoft Print to PDF` 等をダイアログ無しで使うとき。主に検証用） */
  outFile?: string;
}

/**
 * PowerShell を起動して印刷する。
 *
 * **`-EncodedCommand` で渡す**——スクリプトを一時ファイルに書くと実行ポリシーに
 * 引っかかる環境があるし、ディスクに置く必要も無い。
 */
export function printOnWindows(
  opts: WindowsPrintOptions,
  warn: (msg: string) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
    const proc = spawn(
      "powershell.exe",
      // **`-InputFormat None` が要る。** これが無いと、標準入力を繋がずに起動したとき
      // PowerShell が入力を待って**終わらない**（実測でハングした）
      ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-EncodedCommand", encoded],
      {
        // **標準出力も繋ぐ。** NUL に捨てると PowerShell が書き込み先を待って止まる
        // ことがある（実測でハングした）。読み捨てるだけでよい
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TS5250_PRINTER: opts.printer,
          TS5250_FILE: opts.file,
          TS5250_FONT: opts.font ?? "MS Gothic",
          TS5250_SIZE: String(opts.size ?? 8),
          ...(opts.outFile !== undefined ? { TS5250_OUTFILE: opts.outFile } : {})
        }
      }
    );
    // 溜めずに読み捨てる（読まないとパイプが詰まる）
    proc.stdout?.resume();
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => {
      // **理由を捨てない。** 長いスタックは切るが、先頭の 1 行が原因を語る
      if (stderr.length < 2000) stderr += b.toString("utf8");
    });
    proc.on("error", (e) => {
      const msg = `自動印刷に失敗（powershell を起動できません）: ${e.message}`;
      warn(msg);
      resolve({ ok: false, error: msg });
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split("\n")[0] ?? `code ${code}`;
        const msg = `自動印刷に失敗しました: ${detail}`;
        warn(msg);
        resolve({ ok: false, error: msg });
        return;
      }
      resolve({ ok: true });
    });
  });
}
