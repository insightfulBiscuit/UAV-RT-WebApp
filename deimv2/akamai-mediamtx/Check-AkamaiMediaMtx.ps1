param(
    [int]$ProbeSeconds = 8,
    [int]$TcpTimeoutMs = 3000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root "credentials.ps1")
$cfg = $AkamaiMediaMtx

$readUrl = "rtmp://$($cfg.Host):1935/$($cfg.RtmpApp)/$($cfg.RtmpStream)?user=$($cfg.ReadUser)&pass=$($cfg.ReadPass)"

Write-Host "Checking TCP 1935 on $($cfg.Host)..."
try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect($cfg.Host, 1935, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne($TcpTimeoutMs, $false)
    if ($ok) { $client.EndConnect($async) }
    $client.Close()
} catch {
    $ok = $false
}
if (-not $ok) {
    Write-Host "STATE: SERVER_FAILURE"
    Write-Host "Reason: TCP 1935 is not reachable from this PC."
    exit 2
}

if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    Write-Host "STATE: SERVER_REACHABLE"
    Write-Host "Reason: ffprobe is not available locally, so stream readability was not tested."
    exit 0
}

$args = @(
    "-v", "error",
    "-rw_timeout", "$($ProbeSeconds * 1000000)",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-of", "compact=p=0:nk=0",
    $readUrl
)

$stdoutFile = New-TemporaryFile
$stderrFile = New-TemporaryFile
try {
    $proc = Start-Process -FilePath "ffprobe" -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $code = $proc.ExitCode
    $output = Get-Content -LiteralPath $stdoutFile -ErrorAction SilentlyContinue
    $stderr = Get-Content -Raw -LiteralPath $stderrFile -ErrorAction SilentlyContinue
} finally {
    Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
}

if ($code -eq 0 -and ($output | Select-String -Pattern "codec_type=video|codec_name=" -Quiet)) {
    Write-Host "STATE: VIDEO_READABLE"
    $output | ForEach-Object { Write-Host $_ }
    exit 0
}

if ($stderr -match "401|Unauthorized|authentication") {
    Write-Host "STATE: SERVER_FAILURE"
    Write-Host "Reason: ffprobe reached the server but authentication failed."
    exit 3
}

Write-Host "STATE: NO_PUBLISHER"
Write-Host "Reason: TCP 1935 is reachable, but ffprobe did not receive a readable video stream within ${ProbeSeconds}s."
exit 1
