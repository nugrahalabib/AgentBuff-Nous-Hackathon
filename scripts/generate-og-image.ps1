Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root "public\images\logo.png"
$out  = Join-Path $root "public\og-image.png"

$w = 1200
$h = 630

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# Dark background (#030014) with subtle vertical gradient toward indigo.
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(3, 0, 20),
    [System.Drawing.Color]::FromArgb(15, 10, 45),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillRectangle($bgBrush, $rect)
$bgBrush.Dispose()

# Accent glow: soft cyan-indigo radial via big transparent ellipse.
$accentPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$accentPath.AddEllipse(150, 150, 900, 400)
$accentBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($accentPath)
$accentBrush.CenterColor  = [System.Drawing.Color]::FromArgb(60, 129, 140, 248)   # indigo-400 at 24% alpha
$accentBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 3, 0, 20))
$g.FillPath($accentBrush, $accentPath)
$accentBrush.Dispose()
$accentPath.Dispose()

# Logo, scaled to 200x200 top-center.
$srcImg  = [System.Drawing.Image]::FromFile($src)
$logoW   = 200
$logoH   = 200
$logoX   = ($w - $logoW) / 2
$logoY   = 100
$g.DrawImage($srcImg, $logoX, $logoY, $logoW, $logoH)
$srcImg.Dispose()

# Title "AgentBuff" — bold, white.
$titleFont  = New-Object System.Drawing.Font "Segoe UI", 64, ([System.Drawing.FontStyle]::Bold)
$titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$titleStr   = "AgentBuff"
$titleSize  = $g.MeasureString($titleStr, $titleFont)
$g.DrawString($titleStr, $titleFont, $titleBrush, [single](($w - $titleSize.Width) / 2), [single]330)
$titleFont.Dispose()
$titleBrush.Dispose()

# Subtitle — muted blue.
$subFont   = New-Object System.Drawing.Font "Segoe UI", 24, ([System.Drawing.FontStyle]::Regular)
$subBrush  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 210, 225, 255))
$subStr    = "Asisten AI Pribadi untuk Bisnis Kamu"
$subSize   = $g.MeasureString($subStr, $subFont)
$g.DrawString($subStr, $subFont, $subBrush, [single](($w - $subSize.Width) / 2), [single]440)
$subFont.Dispose()
$subBrush.Dispose()

# Domain footer.
$footFont  = New-Object System.Drawing.Font "Segoe UI", 18, ([System.Drawing.FontStyle]::Regular)
$footBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 103, 232, 249))  # cyan-300-ish
$footStr   = "agentbuff.id"
$footSize  = $g.MeasureString($footStr, $footFont)
$g.DrawString($footStr, $footFont, $footBrush, [single](($w - $footSize.Width) / 2), [single]540)
$footFont.Dispose()
$footBrush.Dispose()

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "Wrote $out ($([math]::Round((Get-Item $out).Length/1KB,1)) KB, $w x $h)"
