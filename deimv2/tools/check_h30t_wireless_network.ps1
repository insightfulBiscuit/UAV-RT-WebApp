param(
    [string]$PcIp = "10.0.0.72",
    [int]$UdpPort = 5005,
    [int]$HttpPort = 8010,
    [string]$PythonExe = "D:\anaconda\envs\deepnets\python.exe",
    [string]$OutputDir = "outputs\wireless",
    [string]$ReceiverLog = "outputs\wireless\pc_receiver_stdout.log",
    [switch]$WriteReport
)

$ErrorActionPreference = "Continue"

function Get-FileSnapshot {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path
        return [PSCustomObject]@{
            Path = $Path
            Exists = $true
            Length = $item.Length
            LastWriteTime = $item.LastWriteTime
        }
    }
    return [PSCustomObject]@{
        Path = $Path
        Exists = $false
        Length = 0
        LastWriteTime = $null
    }
}

function Test-CsvGrowth {
    param([string]$Path)
    $before = Get-FileSnapshot -Path $Path
    Start-Sleep -Seconds 2
    $after = Get-FileSnapshot -Path $Path
    return [PSCustomObject]@{
        Path = $Path
        Exists = $after.Exists
        BeforeBytes = $before.Length
        AfterBytes = $after.Length
        Grew = ($after.Length -gt $before.Length)
        LastWriteTime = $after.LastWriteTime
    }
}

function Get-H30TFirewallStatus {
    $rules = Get-NetFirewallRule -DisplayName "H30T*" -ErrorAction SilentlyContinue
    if (-not $rules) {
        return @()
    }
    return $rules | Select-Object DisplayName, Enabled, Direction, Action, Profile
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outputPath = if ([System.IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $root $OutputDir }
$receiverLogPath = if ([System.IO.Path]::IsPathRooted($ReceiverLog)) { $ReceiverLog } else { Join-Path $root $ReceiverLog }

$ipList = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "169.254.*" } |
    Select-Object InterfaceAlias, IPAddress, PrefixLength
$pcIpMatches = @($ipList | Where-Object { $_.IPAddress -eq $PcIp })
$udpEndpoints = @(Get-NetUDPEndpoint -LocalPort $UdpPort -ErrorAction SilentlyContinue)
$tcpListeners = @(Get-NetTCPConnection -LocalPort $HttpPort -State Listen -ErrorAction SilentlyContinue)
$pythonProcesses = @(Get-CimInstance Win32_Process -Filter "name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $PythonExe -or $_.CommandLine -like "*pc_h30t_wireless_system.py*" })
$outputExists = Test-Path -LiteralPath $outputPath
$globalCsv = Join-Path $outputPath "global_temperature.csv"
$matrixCsv = Join-Path $outputPath "matrix_summary.csv"
$globalGrowth = Test-CsvGrowth -Path $globalCsv
$matrixGrowth = Test-CsvGrowth -Path $matrixCsv
$firewallStatus = @(Get-H30TFirewallStatus)
$recentFiles = @()
if ($outputExists) {
    $recentFiles = Get-ChildItem -LiteralPath $outputPath -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 30 FullName, Length, LastWriteTime
}
$recentLog = @()
if (Test-Path -LiteralPath $receiverLogPath) {
    $recentLog = Get-Content -LiteralPath $receiverLogPath -Tail 20 -ErrorAction SilentlyContinue
}

Write-Host "H30T wireless network check"
Write-Host "PC_IP expected: $PcIp"
Write-Host ""
Write-Host "IPv4 addresses:"
$ipList | Format-Table -AutoSize
Write-Host "PC_IP match: $($pcIpMatches.Count -gt 0)"
Write-Host "UDP $UdpPort listening: $($udpEndpoints.Count -gt 0)"
Write-Host "TCP $HttpPort LISTENING: $($tcpListeners.Count -gt 0)"
Write-Host "Python receiver process running: $($pythonProcesses.Count -gt 0)"
Write-Host "Output dir exists: $outputExists ($outputPath)"
Write-Host "global_temperature.csv grew in 2s: $($globalGrowth.Grew) bytes $($globalGrowth.BeforeBytes) -> $($globalGrowth.AfterBytes)"
Write-Host "matrix_summary.csv grew in 2s: $($matrixGrowth.Grew) bytes $($matrixGrowth.BeforeBytes) -> $($matrixGrowth.AfterBytes)"
Write-Host ""
Write-Host "Firewall rules:"
if ($firewallStatus.Count -gt 0) {
    $firewallStatus | Format-Table -AutoSize
} else {
    Write-Host "No H30T firewall rules found."
}

if ($WriteReport) {
    New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
    $reportPath = Join-Path $outputPath "H30T_WIRELESS_NETWORK_DIAG_REPORT.txt"
    $recommendations = New-Object System.Collections.Generic.List[string]
    if ($pcIpMatches.Count -eq 0) {
        $recommendations.Add("PC_IP does not match any local IPv4 address. Update RC App PC_IP or use the active adapter IP.")
    }
    if ($udpEndpoints.Count -eq 0) {
        $recommendations.Add("UDP $UdpPort is not listening. Start RUN_H30T_WIRELESS_SYSTEM.ps1.")
    }
    if ($tcpListeners.Count -eq 0) {
        $recommendations.Add("TCP $HttpPort is not LISTENING. Start RUN_H30T_WIRELESS_SYSTEM.ps1 or check whether the port is occupied.")
    }
    if ($firewallStatus.Count -eq 0) {
        $recommendations.Add("H30T firewall rules are missing. Run tools/setup_h30t_windows_firewall.ps1 as Administrator.")
    }
    if (-not $globalGrowth.Grew) {
        $recommendations.Add("global_temperature.csv is not growing. Check Windows Firewall UDP $UdpPort, RC and PC Wi-Fi network, and RC App logcat.")
    }
    if (-not $matrixGrowth.Grew) {
        $recommendations.Add("matrix_summary.csv is not growing. Check Windows Firewall TCP $HttpPort and HTTP upload logs.")
    }
    if ($recommendations.Count -eq 0) {
        $recommendations.Add("No obvious network blocker found. Compare RC device IP and router client isolation settings.")
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("H30T Wireless Network Diagnostic Report")
    $lines.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')")
    $lines.Add("PC_IP expected: $PcIp")
    $lines.Add("")
    $lines.Add("Local IPv4 addresses:")
    $lines.Add(($ipList | Format-Table -AutoSize | Out-String))
    $lines.Add("PC_IP match: $($pcIpMatches.Count -gt 0)")
    $lines.Add("UDP $UdpPort listening: $($udpEndpoints.Count -gt 0)")
    $lines.Add("TCP $HttpPort LISTENING: $($tcpListeners.Count -gt 0)")
    $lines.Add("Python receiver process running: $($pythonProcesses.Count -gt 0)")
    $lines.Add("")
    $lines.Add("Firewall rule status:")
    if ($firewallStatus.Count -gt 0) {
        $lines.Add(($firewallStatus | Format-Table -AutoSize | Out-String))
    } else {
        $lines.Add("No H30T firewall rules found.")
    }
    $lines.Add("")
    $lines.Add("Recent 20 receiver log lines:")
    if ($recentLog.Count -gt 0) {
        $recentLog | ForEach-Object { $lines.Add($_) }
    } else {
        $lines.Add("No receiver log found at $receiverLogPath")
    }
    $lines.Add("")
    $lines.Add("Recent outputs/wireless file modification times:")
    if ($recentFiles.Count -gt 0) {
        $lines.Add(($recentFiles | Format-Table -AutoSize | Out-String))
    } else {
        $lines.Add("No files found under $outputPath")
    }
    $lines.Add("")
    $lines.Add("CSV growth check:")
    $lines.Add("global_temperature.csv: exists=$($globalGrowth.Exists) grew=$($globalGrowth.Grew) bytes=$($globalGrowth.BeforeBytes)->$($globalGrowth.AfterBytes) lastWrite=$($globalGrowth.LastWriteTime)")
    $lines.Add("matrix_summary.csv: exists=$($matrixGrowth.Exists) grew=$($matrixGrowth.Grew) bytes=$($matrixGrowth.BeforeBytes)->$($matrixGrowth.AfterBytes) lastWrite=$($matrixGrowth.LastWriteTime)")
    $lines.Add("")
    $lines.Add("Recommended next steps:")
    $recommendations | ForEach-Object { $lines.Add("- $_") }
    $lines | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host ""
    Write-Host "Diagnostic report written: $reportPath"
}
