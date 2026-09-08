Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root "credentials.ps1")
$cfg = $AkamaiMediaMtx

ssh $cfg.SshTarget "cd $($cfg.RemoteDir) && docker compose restart mediamtx && docker compose ps"
exit $LASTEXITCODE
