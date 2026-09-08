param(
    [switch]$RemoveFiles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root "credentials.ps1")
$cfg = $AkamaiMediaMtx

$cmd = if ($RemoveFiles) {
    "cd $($cfg.RemoteDir) && docker compose down && cd / && rm -rf $($cfg.RemoteDir)"
} else {
    "cd $($cfg.RemoteDir) && docker compose down"
}

ssh $cfg.SshTarget $cmd
exit $LASTEXITCODE
