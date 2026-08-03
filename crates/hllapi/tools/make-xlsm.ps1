<#
.SYNOPSIS
  docs\hllapi-sample.bas を組み込んだ .xlsm を作る（**Windows / Excel が要る**）。

.DESCRIPTION
  .xlsm の VBA プロジェクト（vbaProject.bin）は OLE 複合ファイルで、
  Linux 側から組み立てるのは現実的でない。**Excel 自身に作らせる**のが確実。

  事前に 1 つだけ設定が要る:
    Excel → ファイル → オプション → トラスト センター → トラスト センターの設定
          → マクロの設定 → 「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」☑
  これが無いと VBComponents.Import が拒否される（エラー 1004）。
  **生成のときだけ必要**な設定なので、作り終えたら戻してよい。

.EXAMPLE
  pwsh -File crates\hllapi\tools\make-xlsm.ps1
  pwsh -File crates\hllapi\tools\make-xlsm.ps1 -Out C:\work\ts5250.xlsm -DllPath C:\ts5250\ts5250hllapi.dll
#>
[CmdletBinding()]
param(
  # 出力先の .xlsm
  [string]$Out = (Join-Path (Get-Location) "ts5250-hllapi.xlsm"),
  # 取り込む VBA モジュール
  [string]$Bas = (Join-Path $PSScriptRoot "..\..\..\docs\hllapi-sample.bas"),
  # DLL の置き場所（.bas の中の宣言をここへ書き換える）
  [string]$DllPath = "C:\ts5250\ts5250hllapi.dll"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Bas)) { throw "$Bas がありません" }
$Out = [System.IO.Path]::GetFullPath($Out)

# DLL の場所を差し替えた一時コピーを作る。
# **Declare の Lib はリテラルしか書けない**ので、変数では渡せず 文字列として置換するしかない。
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "Ts5250Hllapi.bas"
$src = Get-Content -Path $Bas -Raw -Encoding UTF8
$src = $src -replace [regex]::Escape('C:\ts5250\ts5250hllapi.dll'), $DllPath
# VBE は Shift-JIS の .bas を期待する（UTF-8 だと日本語のコメントが化ける）
[System.IO.File]::WriteAllText($tmp, $src, [System.Text.Encoding]::GetEncoding(932))

Write-Host "Excel を起動しています..."
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $book = $excel.Workbooks.Add()

  try {
    $book.VBProject.VBComponents.Import($tmp) | Out-Null
  } catch {
    throw @"
VBA プロジェクトへ書き込めませんでした。
Excel の「VBA プロジェクト オブジェクト モデルへのアクセスを信頼する」を有効にしてください
（ファイル → オプション → トラスト センター → トラスト センターの設定 → マクロの設定）。
元の例外: $($_.Exception.Message)
"@
  }

  # 使い方をシートに書いておく（開いた人が何をすればいいか分かるように）
  $sheet = $book.Worksheets.Item(1)
  $sheet.Name = "使い方"
  $rows = @(
    @("ts5250 HLLAPI サンプル", ""),
    @("", ""),
    @("1.", "ts5250 サーバーを起動する"),
    @("2.", "ブラウザで 5250 セッションを開く（HLLAPI は既にある画面に繋ぐだけ）"),
    @("3.", "DLL を次の場所に置く: $DllPath"),
    @("4.", "Alt+F8 →「例0_セッション一覧」でセッション名を確かめる"),
    @("5.", "Ts5250Hllapi モジュールの Connect(""A"", ""名前"") を自分のセッション名に直す"),
    @("", ""),
    @("注意", "Office と DLL のビット数を合わせること（32bit/64bit）"),
    @("注意", "自動操作は Reserve / Release で囲む（人の打ちかけと衝突する）")
  )
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $sheet.Cells.Item($i + 1, 1).Value2 = $rows[$i][0]
    $sheet.Cells.Item($i + 1, 2).Value2 = $rows[$i][1]
  }
  $sheet.Columns.Item(1).ColumnWidth = 10
  $sheet.Columns.Item(2).ColumnWidth = 80

  # 52 = xlOpenXMLWorkbookMacroEnabled (.xlsm)
  if (Test-Path $Out) { Remove-Item $Out -Force }
  $book.SaveAs($Out, 52)
  $book.Close($false)
  Write-Host "作成しました: $Out"
} finally {
  $excel.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
