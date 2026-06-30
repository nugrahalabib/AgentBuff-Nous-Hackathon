Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcMaster = Join-Path $root "public\images\logo.png"

# Target size table: path → (width, height).
# Sources:
#   - /icon.png        → 512x512  (Next 16 auto-routes src/app/icon.png as /icon.png)
#   - /apple-icon.png  → 180x180  (Apple touch icon convention)
#   - /images/logo.png → 512x512  (main brand asset, also bundled as OG element)
#   - /images/icon-512.png → 512x512
#   - /images/apple-icon.png → 180x180
$targets = @(
    @{ Path = "src\app\icon.png";            W = 512; H = 512 },
    @{ Path = "src\app\apple-icon.png";      W = 180; H = 180 },
    @{ Path = "public\images\logo.png";      W = 512; H = 512 },
    @{ Path = "public\images\icon-512.png";  W = 512; H = 512 },
    @{ Path = "public\images\apple-icon.png"; W = 180; H = 180 }
)

foreach ($t in $targets) {
    $dst = Join-Path $root $t.Path
    if (-not (Test-Path $dst)) {
        Write-Host "skip (missing): $($t.Path)"
        continue
    }

    # Read once to memory stream first, so we can safely overwrite the same path.
    $bytes = [System.IO.File]::ReadAllBytes($dst)
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    $src = [System.Drawing.Image]::FromStream($ms)

    $bmp = New-Object System.Drawing.Bitmap $t.W, $t.H
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    # Preserve transparency — clear to Transparent before drawing.
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $t.W, $t.H)

    $src.Dispose()
    $ms.Dispose()

    $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()

    $sz = [math]::Round((Get-Item $dst).Length / 1KB, 1)
    Write-Host "$($t.Path): $($t.W)x$($t.H), $sz KB"
}
