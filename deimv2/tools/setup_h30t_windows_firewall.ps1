param(
    [string]$PythonExe = "D:\anaconda\envs\deepnets\python.exe",
    [int]$UdpPort = 5005,
    [int]$HttpPort = 8010
)

$ErrorActionPreference = "Stop"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-FirewallRule {
    param(
        [string]$Name,
        [string]$DisplayName,
        [string]$Direction,
        [string]$Action,
        [string]$Protocol,
        [int]$LocalPort = 0,
        [string]$Program = ""
    )

    $rule = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
    if ($rule) {
        Write-Host "Exists: $DisplayName"
        return
    }

    if ($Program) {
        New-NetFirewallRule `
            -Name $Name `
            -DisplayName $DisplayName `
            -Direction $Direction `
            -Action $Action `
            -Program $Program `
            -Profile Any | Out-Null
    } else {
        New-NetFirewallRule `
            -Name $Name `
            -DisplayName $DisplayName `
            -Direction $Direction `
            -Action $Action `
            -Protocol $Protocol `
            -LocalPort $LocalPort `
            -Profile Any | Out-Null
    }
    Write-Host "Created: $DisplayName"
}

if (-not (Test-Admin)) {
    Write-Host "This script must run as Administrator."
    Write-Host "Open Administrator PowerShell and run:"
    Write-Host "powershell -ExecutionPolicy Bypass -File .\tools\setup_h30t_windows_firewall.ps1"
    exit 1
}

if (-not (Test-Path -LiteralPath $PythonExe)) {
    throw "Python executable not found: $PythonExe"
}

Ensure-FirewallRule `
    -Name "H30T_UDP_$UdpPort" `
    -DisplayName "H30T UDP $UdpPort Inbound" `
    -Direction Inbound `
    -Action Allow `
    -Protocol UDP `
    -LocalPort $UdpPort

Ensure-FirewallRule `
    -Name "H30T_TCP_$HttpPort" `
    -DisplayName "H30T TCP $HttpPort Inbound" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $HttpPort

Ensure-FirewallRule `
    -Name "H30T_Python_Inbound" `
    -DisplayName "H30T Python Inbound" `
    -Direction Inbound `
    -Action Allow `
    -Protocol Any `
    -Program $PythonExe

Write-Host ""
Write-Host "Current H30T firewall rules:"
Get-NetFirewallRule -DisplayName "H30T*" -ErrorAction SilentlyContinue |
    Select-Object DisplayName, Enabled, Direction, Action, Profile |
    Format-Table -AutoSize

Write-Host ""
Write-Host "Port filters:"
Get-NetFirewallRule -DisplayName "H30T UDP $UdpPort Inbound","H30T TCP $HttpPort Inbound" -ErrorAction SilentlyContinue |
    Get-NetFirewallPortFilter |
    Select-Object Protocol, LocalPort |
    Format-Table -AutoSize
