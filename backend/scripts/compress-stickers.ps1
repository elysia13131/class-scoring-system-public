# 压缩表情包：表情包/ → backend/wechat/stickers/*.jpg（1080px 宽, quality 85——高清晰，单张 <300KB）
Add-Type -AssemblyName System.Drawing
$srcDir = 'e:\新建文件夹 (3)\表情包'
$dstDir = 'e:\新建文件夹 (3)\backend\wechat\stickers'

# 文件名 → 目标英文 id 文件
$map = [ordered]@{
  '伤心.png'       = 'sad.jpg'
  '吃瓜.png'       = 'melon.jpg'
  '困.png'         = 'sleepy.jpg'
  '在的呀.png'     = 'here.jpg'
  '多喝水.png'     = 'water.jpg'
  '好耶.png'       = 'hooray.jpg'
  '开心.png'       = 'happy.jpg'
  '得意.png'       = 'proud.jpg'
  '才不是ai.png'   = 'notai.jpg'
  '晚安.png'       = 'goodnight.jpg'
  '略略略.png'     = 'nyeh.jpg'
  '过载了喂.png'   = 'overload.jpg'
  '哈哈哈哈.png'   = 'lol.jpg'
  'ok.png'         = 'ok.jpg'
  '不屑，笑出声.jpg' = 'dismiss.jpg'
  '理直气壮.jpg'   = 'brazen.jpg'
  '无法解释.jpg'   = 'noexplain.jpg'
  '开摆.jpg'       = 'giveup.jpg'
  '我是好模型.jpg' = 'goodmodel.jpg'
  '别压力我.jpg'   = 'nopressure.jpg'
}

$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$q = New-Object System.Drawing.Imaging.EncoderParameters(1)
$q.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)

foreach ($k in $map.Keys) {
  $src = Join-Path $srcDir $k
  $dst = Join-Path $dstDir $map[$k]
  if (-not (Test-Path $src)) { Write-Host "MISS $k"; continue }
  $img = [System.Drawing.Image]::FromFile($src)
  $w = 1080
  $h = [int][math]::Round($img.Height * 1080 / $img.Width)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($img, 0, 0, $w, $h)
  $bmp.Save($dst, $enc, $q)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  $size = (Get-Item $dst).Length
  Write-Host ("OK {0}  {1,6:N1} KB" -f $map[$k], ($size / 1KB))
}
Write-Host 'done'
