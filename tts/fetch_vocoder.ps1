# =============================================================================
#  fetch_vocoder.ps1 - download the BigVGAN vocoder for IndexTTS-2
#
#  Why this exists:
#    On first inference IndexTTS-2 downloads 4 auxiliary models. Three of them
#    come from ModelScope (fast in China), but the vocoder
#    "bigvgan_generator.pt" (428 MB) has no Chinese mirror - it is served from
#    HuggingFace's CDN at roughly 76 KB/s and frequently stalls mid-download
#    (the file sits at a few hundred KB for tens of minutes).
#    This script pulls it over 8 parallel range requests instead, which is about
#    2-3x faster here, and it is safe to run again if it gets interrupted.
#
#  ASCII only - do not add non-ASCII characters to this file.
# =============================================================================

$ErrorActionPreference = 'Continue'

$Url      = 'https://hf-mirror.com/nvidia/bigvgan_v2_22khz_80band_256x/resolve/main/bigvgan_generator.pt'
$Total    = 449228171
$ChunkDir = 'D:\index-tts\_chunk'
$OutFile  = 'D:\index-tts\checkpoints_2\hf_cache\bigvgan\bigvgan_generator.pt'
$Parts    = 8

Write-Host '============================================================'
Write-Host '  BigVGAN vocoder downloader (8 parallel connections)'
Write-Host '============================================================'
Write-Host ('  target : ' + $OutFile)
Write-Host ('  size   : ' + $Total + ' bytes (about 428 MB)')
Write-Host ''

if (-not (Test-Path 'D:\index-tts')) {
    Write-Host '  ERROR: D:\index-tts not found. Run setup_index_tts.cmd first.'
    exit 1
}

# already complete?
if (Test-Path $OutFile) {
    $have = (Get-Item $OutFile).Length
    if ($have -eq $Total) {
        Write-Host '  Already downloaded and complete. Nothing to do.'
        exit 0
    }
    Write-Host ('  existing file is ' + $have + ' bytes - will be replaced.')
}

if (-not (Test-Path $ChunkDir)) { New-Item -ItemType Directory -Path $ChunkDir -Force | Out-Null }
New-Item -ItemType Directory -Path (Split-Path $OutFile) -Force | Out-Null

$Chunk = [math]::Ceiling($Total / $Parts)

function Get-Part($i) {
    # reuse an already complete part
    $p = Join-Path $ChunkDir ('c' + $i + '.bin')
    $start = $i * $Chunk
    $end   = [math]::Min(($i + 1) * $Chunk - 1, $Total - 1)
    $need  = $end - $start + 1
    if ((Test-Path $p) -and ((Get-Item $p).Length -eq $need)) { return $true }
    return $false
}

$procs = @()
for ($i = 0; $i -lt $Parts; $i++) {
    if (Get-Part $i) { Write-Host ('  part ' + $i + ': already complete'); continue }
    $start = $i * $Chunk
    $end   = [math]::Min(($i + 1) * $Chunk - 1, $Total - 1)
    $out   = Join-Path $ChunkDir ('c' + $i + '.bin')
    $args  = @('-sL', '--noproxy', '*', '--retry', '60', '--retry-delay', '3',
               '--retry-all-errors', '--speed-limit', '3000', '--speed-time', '60',
               '--connect-timeout', '20',
               '-r', ($start.ToString() + '-' + $end.ToString()), '-o', $out, $Url)
    Write-Host ('  part ' + $i + ': bytes ' + $start + '..' + $end)
    $procs += Start-Process -FilePath 'curl.exe' -ArgumentList $args -NoNewWindow -PassThru
}
if ($procs.Count -gt 0) {
    Write-Host ''
    Write-Host '  downloading ... (this takes 15-45 minutes, keep the window open)'
    foreach ($p in $procs) { $p.WaitForExit() }
}

# verify
$bad = $false
for ($i = 0; $i -lt $Parts; $i++) {
    if (-not (Get-Part $i)) { $bad = $true }
}
if ($bad) {
    Write-Host ''
    Write-Host '  INCOMPLETE - some parts failed. Just run this script again to resume.'
    exit 1
}

# merge
Write-Host ''
Write-Host '  merging parts ...'
$fs = [IO.File]::Create($OutFile)
try {
    for ($i = 0; $i -lt $Parts; $i++) {
        $b = [IO.File]::ReadAllBytes((Join-Path $ChunkDir ('c' + $i + '.bin')))
        $fs.Write($b, 0, $b.Length)
    }
} finally {
    $fs.Close()
}

$final = (Get-Item $OutFile).Length
if ($final -eq $Total) {
    Remove-Item $ChunkDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '============================================================'
    Write-Host '  DONE'
    Write-Host '============================================================'
    Write-Host ('  ' + $OutFile)
    Write-Host ('  ' + $final + ' bytes')
    Write-Host ''
    Write-Host '  Next: double-click  tts\try_voice.cmd'
    exit 0
} else {
    Write-Host ('  ERROR: merged file is ' + $final + ' bytes, expected ' + $Total)
    exit 1
}
