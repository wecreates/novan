# Generate Novan brand icon — PNG + multi-size ICO using System.Drawing.
# Produces:
#   apps/web/public/icon.png   (512x512, for web/PWA)
#   apps/web/public/icon.ico   (multi-resolution, for Windows shortcuts)

Add-Type -AssemblyName System.Drawing

$ROOT   = Split-Path $PSScriptRoot -Parent
$PUBLIC = Join-Path $ROOT 'apps\web\public'
New-Item -ItemType Directory -Force -Path $PUBLIC | Out-Null

function New-NovanBitmap {
  param([int]$Size)

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  # ── Black rounded square background ────────────────────────────────
  $corner = [int]($Size * 0.20)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $corner, $corner, 180, 90)
  $path.AddArc($Size - $corner, 0, $corner, $corner, 270, 90)
  $path.AddArc($Size - $corner, $Size - $corner, $corner, $corner, 0, 90)
  $path.AddArc(0, $Size - $corner, $corner, $corner, 90, 90)
  $path.CloseFigure()
  $g.FillPath([System.Drawing.Brushes]::Black, $path)

  # Subtle metallic border
  $borderColor = [System.Drawing.Color]::FromArgb(60, 60, 60)
  $borderPen = New-Object System.Drawing.Pen $borderColor, ([Math]::Max(1, $Size * 0.008))
  $g.DrawPath($borderPen, $path)

  # ── Metallic N ─────────────────────────────────────────────────────
  # Silver gradient: light at top-left, darker at bottom-right
  $rect = New-Object System.Drawing.RectangleF 0, 0, $Size, $Size
  $silver = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
      $rect, ([System.Drawing.Color]::FromArgb(248,248,248)), ([System.Drawing.Color]::FromArgb(170,170,170)), 135
  $silverDark = New-Object System.Drawing.Drawing2D.LinearGradientBrush `
      $rect, ([System.Drawing.Color]::FromArgb(130,130,130)), ([System.Drawing.Color]::FromArgb(75,75,75)), 135

  # Three polygons forming N: left vertical, diagonal, right vertical
  $s = [single]$Size
  $leftV = @(
    (New-Object System.Drawing.PointF (0.27*$s), (0.20*$s))
    (New-Object System.Drawing.PointF (0.39*$s), (0.20*$s))
    (New-Object System.Drawing.PointF (0.39*$s), (0.80*$s))
    (New-Object System.Drawing.PointF (0.27*$s), (0.80*$s))
  )
  $rightV = @(
    (New-Object System.Drawing.PointF (0.61*$s), (0.20*$s))
    (New-Object System.Drawing.PointF (0.73*$s), (0.20*$s))
    (New-Object System.Drawing.PointF (0.73*$s), (0.80*$s))
    (New-Object System.Drawing.PointF (0.61*$s), (0.80*$s))
  )
  $diag = @(
    (New-Object System.Drawing.PointF (0.39*$s), (0.20*$s))
    (New-Object System.Drawing.PointF (0.51*$s), (0.20*$s))
    (New-Object System.Drawing.PointF (0.73*$s), (0.80*$s))
    (New-Object System.Drawing.PointF (0.61*$s), (0.80*$s))
  )

  $g.FillPolygon($silver,     $leftV)
  $g.FillPolygon($silverDark, $diag)
  $g.FillPolygon($silver,     $rightV)

  $g.Dispose()
  return $bmp
}

# ── Write PNG (512x512) ─────────────────────────────────────────────────
$pngPath = Join-Path $PUBLIC 'icon.png'
$png = New-NovanBitmap -Size 512
$png.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()
Write-Host "✓ Wrote $pngPath" -ForegroundColor Green

# ── Write ICO (multi-resolution: 16, 32, 48, 256) ───────────────────────
$icoPath = Join-Path $PUBLIC 'icon.ico'
$sizes = 16, 32, 48, 256
$bitmaps = @{}
foreach ($sz in $sizes) { $bitmaps[$sz] = New-NovanBitmap -Size $sz }

# Build ICO file binary by hand (multi-image format)
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $stream

# ICONDIR header (6 bytes)
$writer.Write([UInt16]0)                  # reserved
$writer.Write([UInt16]1)                  # type 1 = ICO
$writer.Write([UInt16]$sizes.Count)       # image count

# Convert each bitmap to PNG bytes
$pngBytesPerSize = @{}
foreach ($sz in $sizes) {
  $ms = New-Object System.IO.MemoryStream
  $bitmaps[$sz].Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytesPerSize[$sz] = $ms.ToArray()
  $ms.Dispose()
}

# Offset starts after ICONDIR (6) + N * ICONDIRENTRY (16 each)
$offset = 6 + (16 * $sizes.Count)

# ICONDIRENTRY rows (16 bytes each)
foreach ($sz in $sizes) {
  $byteSize = $sz
  if ($byteSize -eq 256) { $byteSize = 0 }   # 256 stored as 0
  $writer.Write([byte]$byteSize)             # width
  $writer.Write([byte]$byteSize)             # height
  $writer.Write([byte]0)                     # palette
  $writer.Write([byte]0)                     # reserved
  $writer.Write([UInt16]1)                   # color planes
  $writer.Write([UInt16]32)                  # bits per pixel
  $writer.Write([UInt32]$pngBytesPerSize[$sz].Length)  # data size
  $writer.Write([UInt32]$offset)             # data offset
  $offset += $pngBytesPerSize[$sz].Length
}

# Append PNG data for each image
foreach ($sz in $sizes) {
  $writer.Write($pngBytesPerSize[$sz])
}

[System.IO.File]::WriteAllBytes($icoPath, $stream.ToArray())
$writer.Close()
$stream.Dispose()
foreach ($sz in $sizes) { $bitmaps[$sz].Dispose() }

$kb = [Math]::Round((Get-Item $icoPath).Length / 1024, 1)
Write-Host "Wrote $icoPath ($kb KB, 4 sizes)" -ForegroundColor Green
