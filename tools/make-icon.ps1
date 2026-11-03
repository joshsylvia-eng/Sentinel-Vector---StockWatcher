# Generates build/icon.png (512x512) for the Windows executable.
# Pure System.Drawing so it needs no extra tooling.

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir 'icon.png'

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$inset = 22
$rect = New-Object System.Drawing.Rectangle($inset, $inset, ($size - 2 * $inset), ($size - 2 * $inset))
$radius = 104

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc(($rect.Right - $radius), $rect.Y, $radius, $radius, 270, 90)
$path.AddArc(($rect.Right - $radius), ($rect.Bottom - $radius), $radius, $radius, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $radius), $radius, $radius, 90, 90)
$path.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(52, 211, 153),
  [System.Drawing.Color]::FromArgb(56, 189, 248),
  45.0
)
$g.FillPath($brush, $path)

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(6, 20, 12), 36)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$points = @(
  (New-Object System.Drawing.PointF(118, 336)),
  (New-Object System.Drawing.PointF(206, 236)),
  (New-Object System.Drawing.PointF(292, 300)),
  (New-Object System.Drawing.PointF(394, 158))
)
$g.DrawLines($pen, $points)

$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(6, 20, 12))
$g.FillEllipse($dot, 366, 130, 56, 56)

$pen.Dispose()
$brush.Dispose()
$dot.Dispose()
$g.Dispose()

$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "Wrote $outFile"
