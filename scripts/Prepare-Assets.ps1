$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$assets = @(
    @{ Path = 'wwwroot/lib/signalr/signalr.min.js'; Url = 'https://cdn.jsdelivr.net/npm/@microsoft/signalr@10.0.11/dist/browser/signalr.min.js' },
    @{ Path = 'wwwroot/lib/signalr/LICENSE.txt'; Url = 'https://raw.githubusercontent.com/dotnet/aspnetcore/v10.0.11/LICENSE.txt' },
    @{ Path = 'wwwroot/lib/lucide/lucide.min.js'; Url = 'https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js' },
    @{ Path = 'wwwroot/lib/lucide/LICENSE'; Url = 'https://cdn.jsdelivr.net/npm/lucide@0.468.0/LICENSE' }
)
foreach ($asset in $assets) {
    $target = Join-Path $root $asset.Path
    [System.IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
    Invoke-WebRequest -Uri $asset.Url -OutFile $target
}
Add-Type -AssemblyName System.Drawing
$iconFolder = Join-Path $root 'wwwroot/icons'
[System.IO.Directory]::CreateDirectory($iconFolder) | Out-Null
foreach ($icon in @(
    @{ Name = 'icon-192.png'; Size = 192 },
    @{ Name = 'icon-512.png'; Size = 512 },
    @{ Name = 'icon-maskable-512.png'; Size = 512 },
    @{ Name = 'apple-touch-icon.png'; Size = 180 }
)) {
    $bitmap = [System.Drawing.Bitmap]::new($icon.Size, $icon.Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#176645'))
    $graphics.ScaleTransform($icon.Size / 512.0, $icon.Size / 512.0)
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f4fff8'))
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(122, 160, 40, 40, 180, 90)
    $path.AddArc(274, 160, 40, 40, 270, 90)
    $path.AddArc(274, 312, 40, 40, 0, 90)
    $path.AddArc(122, 312, 40, 40, 90, 90)
    $path.CloseFigure()
    $graphics.FillPath($brush, $path)
    $points = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(330, 220), [System.Drawing.PointF]::new(390, 181), [System.Drawing.PointF]::new(390, 331), [System.Drawing.PointF]::new(330, 292))
    $graphics.FillPolygon($brush, $points)
    $bitmap.Save((Join-Path $iconFolder $icon.Name), [System.Drawing.Imaging.ImageFormat]::Png)
    $path.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
Write-Output 'Prepared SignalR 10.0.11, Lucide 0.468.0, license notices, and four PNG icons.'