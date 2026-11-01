$ErrorActionPreference = "SilentlyContinue"
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$Ports = @(9772, 9774)
$DaemonJson = Join-Path $DataDir "daemon.json"
if (Test-Path $DaemonJson) {
    try {
        $Cfg = Get-Content -Raw -Path $DaemonJson | ConvertFrom-Json
        if ($Cfg.port) {
            $CfgPort = [int]$Cfg.port
            if ($Ports -notcontains $CfgPort) { $Ports += $CfgPort }
        }
    } catch {}
}
foreach ($Port in $Ports) {
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/flush-and-close" -Method Get -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
    } catch {}
}
Start-Sleep -Milliseconds 1000
$Stopped = 0
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $Stopped++
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
