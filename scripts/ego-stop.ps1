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
    # 只有 Stop-Process 真的成功才計入 terminated。-ErrorAction SilentlyContinue 會把
    # 「權限不足」這類錯誤吞掉，因此再用 $? 與 try/catch 確認一次；失敗一律不遞增。
    try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        if ($?) { $Stopped++ }
    } catch {
    }
}

# 終止後重新查詢同一組條件，最多輪詢 5 秒，確認符合條件的程序真的已不存在。
$Remaining = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
})
$WaitedMs = 0
while (($Remaining.Count -gt 0) -and ($WaitedMs -lt 5000)) {
    Start-Sleep -Milliseconds 500
    $WaitedMs += 500
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
    })
}

if ($Remaining.Count -gt 0) {
    $RemainingPids = (($Remaining | ForEach-Object { $_.ProcessId }) -join ",")
    Write-Output "EGO_STOP_FAILED (terminated $Stopped processes, still running: $RemainingPids)"
    exit 1
}

Write-Output "EGO_STOPPED (terminated $Stopped processes)"
exit 0
