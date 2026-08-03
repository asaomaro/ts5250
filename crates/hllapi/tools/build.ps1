<#
.SYNOPSIS
  HLLAPI の DLL を Windows 上でビルドする（MSVC）。

.DESCRIPTION
  Linux から作りたい場合は crates/hllapi/tools/build.sh --windows を使う（mingw 版が出る）。
  こちらは Windows 上で MSVC ツールチェーンを使う場合。

  **Office と同じビット数の DLL を使うこと。** 64bit Office なら x64、
  32bit Office なら x86。合っていないと VBA から
  「指定されたモジュールが見つかりません」になる（パスの問題ではない）。

  ビルドの後で必ず検査する（エクスポート名と呼び出し規約）。
  **ビルドが通ったことは正しさの保証にならない**——32bit が cdecl のままだと
  VBA から呼んだ瞬間にスタックが壊れる。

.PARAMETER Arch
  x64 / x86 / both（既定 both）

.PARAMETER Install
  出来た DLL をここへ複写する（例 C:\ts5250）

.EXAMPLE
  pwsh -File crates\hllapi\tools\build.ps1
  pwsh -File crates\hllapi\tools\build.ps1 -Arch x86 -Install C:\ts5250
#>
[CmdletBinding()]
param(
  [ValidateSet("x64", "x86", "both")]
  [string]$Arch = "both",
  [string]$Install
)

$ErrorActionPreference = "Stop"
$crate = Join-Path $PSScriptRoot ".."
$checker = Join-Path $PSScriptRoot "check-dll.py"

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo がありません。https://rustup.rs から入れてください"
}

$targets = @()
if ($Arch -in @("x64", "both")) { $targets += "x86_64-pc-windows-msvc" }
if ($Arch -in @("x86", "both")) { $targets += "i686-pc-windows-msvc" }

$installed = (rustup target list --installed) -split "`r?`n"
$outputs = @()

foreach ($t in $targets) {
  if ($installed -notcontains $t) {
    Say "rustup target add $t"
    rustup target add $t
  }
  Say "ビルド: $t"
  cargo build --release --manifest-path (Join-Path $crate "Cargo.toml") --target $t
  if ($LASTEXITCODE -ne 0) {
    throw @"
ビルドに失敗しました。MSVC のリンカが要ります。
Visual Studio Build Tools の「C++ によるデスクトップ開発」を入れるか、
Linux から crates/hllapi/tools/build.sh --windows で mingw 版を作ってください。
"@
  }
  $outputs += (Join-Path $crate "target\$t\release\ts5250hllapi.dll")
}

# **作った後で必ず検査する**
if (Get-Command python -ErrorAction SilentlyContinue) {
  Say "検査"
  python $checker @outputs
  if ($LASTEXITCODE -ne 0) { throw "検査に失敗しました" }
} else {
  Write-Warning "python が無いので検査を飛ばします（crates\hllapi\tools\check-dll.py）"
}

if ($Install) {
  New-Item -ItemType Directory -Force -Path $Install | Out-Null
  foreach ($o in $outputs) {
    # 同じ名前なので、両方作ったときは後ろが勝つ。**分けて置くこと**
    $suffix = if ($o -match "i686") { "-x86" } else { "-x64" }
    $dest = Join-Path $Install ("ts5250hllapi{0}.dll" -f ($(if ($targets.Count -gt 1) { $suffix } else { "" })))
    Copy-Item $o $dest -Force
    Write-Host "  複写: $dest"
  }
  if ($targets.Count -gt 1) {
    Write-Host ""
    Write-Host "**使うほうを ts5250hllapi.dll に改名すること**（Office のビット数に合わせる）" -ForegroundColor Yellow
  }
}

Say "出来上がり"
$outputs | ForEach-Object { Write-Host "  $_" }
