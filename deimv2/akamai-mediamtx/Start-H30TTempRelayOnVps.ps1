param(
    [string]$VpsHost = "172.239.170.143",
    [string]$VpsUser = "root",
    [int]$VpsRelayPort = 8092,
    [string]$Token = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RemoteDir = "/opt/h30t-temp-relay"

Write-Host "Uploading H30T temperature WebSocket relay to ${VpsUser}@${VpsHost}:$RemoteDir"
ssh "$VpsUser@$VpsHost" "mkdir -p $RemoteDir"
$RemoteTarget = "${VpsUser}@${VpsHost}:$RemoteDir/h30t_adb_temp_ws_gateway.py"
scp (Join-Path $Root "tools\h30t_adb_temp_ws_gateway.py") $RemoteTarget

$remoteCmd = "if [ -s $RemoteDir/relay.pid ]; then read oldpid < $RemoteDir/relay.pid; if kill -0 `$oldpid 2>/dev/null; then kill `$oldpid; fi; fi; nohup python3 $RemoteDir/h30t_adb_temp_ws_gateway.py server --host 127.0.0.1 --port $VpsRelayPort"
if ($Token) { $remoteCmd += " --token '$Token'" }
$remoteCmd += " > $RemoteDir/relay.log 2>&1 & echo `$! > $RemoteDir/relay.pid"
ssh "$VpsUser@$VpsHost" $remoteCmd

Write-Host "Started VPS relay on 127.0.0.1:$VpsRelayPort."
Write-Host "Use SSH local forwarding from field and remote PCs; no Akamai firewall change is required."
