# build/icon.png から Windows 用のマルチサイズ icon.ico を生成する。
#
# electron-builder は icon.ico が無いと icon.png から自動変換するが、その結果は
# 256x256 の 1 エントリだけになり、タスクバー/エクスプローラの 16・32px 表示が
# 縮小のぼけになる。各サイズを高品質に焼いた ico をコミットしてそれを使わせる。
#
# 使い方: pwsh -File scripts/make-icon-ico.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'build/icon.png'
$dst  = Join-Path $root 'build/icon.ico'
$sizes = 16, 24, 32, 48, 64, 128, 256

$source = [System.Drawing.Bitmap]::new($src)
$pngs = foreach ($size in $sizes) {
    $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = 'HighQualityBicubic'
    $g.PixelOffsetMode    = 'HighQuality'
    $g.SmoothingMode      = 'HighQuality'
    $g.CompositingQuality = 'HighQuality'
    $g.CompositingMode    = 'SourceCopy'
    $g.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
    $g.Dispose()
    $ms = [System.IO.MemoryStream]::new()
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    ,$ms.ToArray()
}
$source.Dispose()

# ICONDIR + ICONDIRENTRY[] + PNG 本体。Vista 以降は各エントリを PNG のまま置ける。
$out = [System.IO.MemoryStream]::new()
$w = [System.IO.BinaryWriter]::new($out)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $size = $sizes[$i]
    $w.Write([byte]($size % 256))   # 256 は 0 で表す
    $w.Write([byte]($size % 256))
    $w.Write([byte]0)               # パレット色数（トゥルーカラーは 0）
    $w.Write([byte]0)               # 予約
    $w.Write([uint16]1)             # プレーン数
    $w.Write([uint16]32)            # ビット深度
    $w.Write([uint32]$pngs[$i].Length)
    $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($png in $pngs) { $w.Write($png) }
$w.Flush()
[System.IO.File]::WriteAllBytes($dst, $out.ToArray())
$w.Dispose()

Write-Host "generated $dst ($((Get-Item $dst).Length) bytes, $($sizes.Count) sizes)"
