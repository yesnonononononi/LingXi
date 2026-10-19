# Generates deskpet/assets/tray.png (32x32, transparent).
# Run once: powershell -ExecutionPolicy Bypass -File scripts/gen-tray-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path (Split-Path -Parent $here) 'assets\tray.png'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

$size = 32
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$brushHair = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#FDFBF8'))
$brushShade = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#E9E2DC'))
$brushEye = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#5E87B0'))
$brushBlush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#FBDED7'))
$penOutline = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#D9C4B6')), 1.2

# ears first, head covers their base
$leftEar = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(6, 16)),
  (New-Object System.Drawing.Point(8, 2)),
  (New-Object System.Drawing.Point(17, 13))
)
$rightEar = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(26, 16)),
  (New-Object System.Drawing.Point(24, 2)),
  (New-Object System.Drawing.Point(15, 13))
)
$g.FillPolygon($brushHair, $leftEar)
$g.FillPolygon($brushHair, $rightEar)

$head = New-Object System.Drawing.Rectangle(5, 11, 22, 20)
$g.FillEllipse($brushHair, $head)
$g.DrawEllipse($penOutline, $head)

$g.FillEllipse($brushBlush, (New-Object System.Drawing.Rectangle(8, 22, 5, 3)))
$g.FillEllipse($brushBlush, (New-Object System.Drawing.Rectangle(19, 22, 5, 3)))

$g.FillEllipse($brushEye, (New-Object System.Drawing.Rectangle(10, 18, 4, 5)))
$g.FillEllipse($brushEye, (New-Object System.Drawing.Rectangle(18, 18, 4, 5)))

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$brushHair.Dispose()
$brushShade.Dispose()
$brushEye.Dispose()
$brushBlush.Dispose()
$penOutline.Dispose()

Write-Host "wrote $out"
