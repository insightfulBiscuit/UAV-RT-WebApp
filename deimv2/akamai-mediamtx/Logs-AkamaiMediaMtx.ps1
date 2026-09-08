param(
    [int]$Tail = 120,
    [switch]$Follow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root "credentials.ps1")
$cfg = $AkamaiMediaMtx
$followArg = if ($Follow) { "-f" } else { "" }

ssh $cfg.SshTarget "cd $($cfg.RemoteDir) && docker compose logs --tail $Tail $followArg mediamtx"
exit $LASTEXITCODE
