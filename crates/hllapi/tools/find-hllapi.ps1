<#
.SYNOPSIS
  この PC に入っている HLLAPI の実装を探す（ts5250 以外も含む）。

.DESCRIPTION
  **「入っているか」を記憶や伝聞で決めない。** DLL のエクスポートを実際に読んで、
  HLLAPI のエントリ（hllapi / HLLAPI / WinHLLAPI / hllc）を持つものを挙げる。

  用途は 2 つ:

  1. **ACS / PCOMM / 旧 iSeries Access のどれが HLLAPI を提供しているか**を確かめる
     （ACS 単体には無く、Windows Application Package のような追加物が要る場合がある）
  2. VBA の `Declare ... Lib` に書く**正しい DLL 名とビット数**を知る
     （Office と DLL のビット数が違うと「モジュールが見つかりません」になる）

  外部ツールを使わない（PE を自前で読む）。管理者権限も要らない。

.EXAMPLE
  pwsh -File crates\hllapi\tools\find-hllapi.ps1
  pwsh -File crates\hllapi\tools\find-hllapi.ps1 -Path "C:\Program Files (x86)\IBM"
#>
[CmdletBinding()]
param(
  # 追加で探す場所。既定は IBM 系と ts5250 の置き場所
  [string[]]$Path
)

$ErrorActionPreference = "Continue"

$WANT = @("hllapi", "HLLAPI", "WinHLLAPI", "hllc")

# 既定の探索先。**ACS は Public 配下、旧 Client Access は Program Files 配下**
$roots = @(
  "C:\Users\Public\IBM",
  "C:\Program Files\IBM",
  "C:\Program Files (x86)\IBM",
  "C:\ts5250"
)
if ($Path) { $roots = $Path }

function Get-PeExports([string]$file) {
  # PE のエクスポート表を読む。壊れていたら黙って null を返す（探索を止めない）
  try {
    $fs = [System.IO.File]::OpenRead($file)
    $br = New-Object System.IO.BinaryReader($fs)
    $bytes = New-Object byte[] ([Math]::Min($fs.Length, 4MB))
    [void]$fs.Read($bytes, 0, $bytes.Length)
    $fs.Close()

    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { return $null }   # MZ
    $pe = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($pe -le 0 -or $pe + 100 -ge $bytes.Length) { return $null }
    if ([BitConverter]::ToInt32($bytes, $pe) -ne 0x00004550) { return $null }  # PE\0\0

    $machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
    $nsec = [BitConverter]::ToUInt16($bytes, $pe + 6)
    $optsz = [BitConverter]::ToUInt16($bytes, $pe + 20)
    $optoff = $pe + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optoff)
    $is64 = ($magic -eq 0x20B)

    $secs = @()
    for ($i = 0; $i -lt $nsec; $i++) {
      $o = $optoff + $optsz + 40 * $i
      $secs += , @(
        [BitConverter]::ToUInt32($bytes, $o + 8),   # VirtualSize
        [BitConverter]::ToUInt32($bytes, $o + 12),  # VirtualAddress
        [BitConverter]::ToUInt32($bytes, $o + 16),  # SizeOfRawData
        [BitConverter]::ToUInt32($bytes, $o + 20)   # PointerToRawData
      )
    }
    function R2O([uint32]$rva) {
      foreach ($s in $secs) {
        $span = [Math]::Max($s[0], $s[2])
        if ($rva -ge $s[1] -and $rva -lt $s[1] + $span) { return [int]($s[3] + ($rva - $s[1])) }
      }
      return -1
    }

    $erva = [BitConverter]::ToUInt32($bytes, $optoff + $(if ($is64) { 112 } else { 96 }))
    if ($erva -eq 0) { return $null }
    $eo = R2O $erva
    if ($eo -lt 0 -or $eo + 40 -ge $bytes.Length) { return $null }

    $nName = [BitConverter]::ToUInt32($bytes, $eo + 24)
    $nameTbl = [BitConverter]::ToUInt32($bytes, $eo + 32)
    $nt = R2O $nameTbl
    if ($nt -lt 0) { return $null }

    $names = @()
    for ($i = 0; $i -lt [Math]::Min($nName, 4000); $i++) {
      $nr = [BitConverter]::ToUInt32($bytes, $nt + 4 * $i)
      $o = R2O $nr
      if ($o -lt 0 -or $o -ge $bytes.Length) { continue }
      $e = $o
      while ($e -lt $bytes.Length -and $bytes[$e] -ne 0) { $e++ }
      $names += [Text.Encoding]::ASCII.GetString($bytes, $o, $e - $o)
    }
    return @{ Arch = $(if ($machine -eq 0x8664) { "x64" } elseif ($machine -eq 0x14C) { "x86" } else { "?" }); Names = $names }
  } catch {
    return $null
  }
}

Write-Host "HLLAPI のエントリを持つ DLL を探しています..." -ForegroundColor Cyan
$found = @()

foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Write-Host "  探索: $root"
  Get-ChildItem -Path $root -Filter *.dll -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $info = Get-PeExports $_.FullName
    if (-not $info) { return }
    $hit = $WANT | Where-Object { $info.Names -contains $_ }
    if ($hit.Count -gt 0) {
      $found += [pscustomobject]@{
        DLL     = $_.Name
        Arch    = $info.Arch
        Entries = ($hit -join ", ")
        Path    = $_.FullName
      }
    }
  }
}

Write-Host ""
if ($found.Count -eq 0) {
  Write-Host "見つかりませんでした。" -ForegroundColor Yellow
  Write-Host @"

ACS 本体（Java 版）は HLLAPI の DLL を持ちません。追加で入れるものがあるとすれば
「IBM i Access Client Solutions - Windows Application Package」です。
入っていてもここに出ないなら、そのパッケージには HLLAPI が含まれていません。

同じ VBA を動かせる相手:
  - IBM Personal Communications        (pcshll32.dll / ehlapi32.dll)
  - iSeries Access for Windows（旧）   (PC5250 の EHLLAPI)
  - ts5250                             (ts5250hllapi.dll)

別の場所を見るなら -Path で指定してください。
"@
} else {
  Write-Host "見つかりました:" -ForegroundColor Green
  $found | Format-Table -AutoSize
  Write-Host @"
VBA の Declare にはこの DLL 名（またはフルパス）を書きます。
**Office と Arch を合わせること**——違うと「指定されたモジュールが見つかりません」に
なります（パスの問題ではありません）。Office のビット数は
Excel の「ファイル → アカウント → Excel のバージョン情報」で分かります。
"@
}
