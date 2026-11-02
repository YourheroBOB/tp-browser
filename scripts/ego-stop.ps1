$ErrorActionPreference = "SilentlyContinue"
$DataDir = if ($env:EGO_LINUX_DATA_DIR) { $env:EGO_LINUX_DATA_DIR } elseif ($HOME) { Join-Path $HOME ".local\share\ego-linux" } else { Join-Path $env:USERPROFILE ".local\share\ego-linux" }
$ProfileDir = Join-Path $DataDir "profile-agent"
$Ports = @(9772, 9774)
foreach ($EnvPort in @($env:TP_DAEMON_PORT, $env:EGO_DAEMON_PORT)) {
    if ($EnvPort) {
        try {
            $EP = [int]$EnvPort
            if ($EP -ge 1 -and $EP -le 65535 -and $Ports -notcontains $EP) { $Ports += $EP }
        } catch {}
    }
}
$DaemonJson = Join-Path $DataDir "daemon.json"
if (Test-Path $DaemonJson) {
    try {
        $Cfg = Get-Content -Raw -Path $DaemonJson | ConvertFrom-Json
        if ($Cfg.port) {
            $CfgPort = [int]$Cfg.port
            if ($CfgPort -ge 1 -and $CfgPort -le 65535 -and $Ports -notcontains $CfgPort) { $Ports += $CfgPort }
        }
    } catch {}
}
foreach ($Port in $Ports) {
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port/flush-and-close" -Method Get -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
    } catch {}
}
Start-Sleep -Milliseconds 1000

# 比對準則（刻意保守，寧可少殺不可誤殺）：
#   1. daemon 本體：命令列含 ego-browserd.js 或 tp-browserd.js。
#   2. 本專案 profile 的瀏覽器：命令列含舊版固定字串 ego-linux\profile-agent，
#      或含由 $DataDir 推導出的實際 profile 路徑（支援 EGO_LINUX_DATA_DIR 自訂目錄）。
#      路徑比對一律用 OrdinalIgnoreCase 子字串比對，不用 -like：
#      -like 會把 [ ] 當萬用字元字元集，HOME 或 DataDir 含 "[" 時比對會靜默失效。
$TerminatedPids = [System.Collections.Generic.HashSet[int]]::new()
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave|chromium)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*" -or ([string]$_.CommandLine).IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    [void]$TerminatedPids.Add($_.ProcessId)
}
$Stopped = $TerminatedPids.Count

$Remaining = @()
for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave|chromium)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*" -or ([string]$_.CommandLine).IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    if ($Remaining.Count -eq 0) { break }
    foreach ($Proc in $Remaining) {
        Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
        [void]$TerminatedPids.Add($Proc.ProcessId)
    }
    $Stopped = $TerminatedPids.Count
    Start-Sleep -Milliseconds 300
}

# 強制終止是非同步的：Stop-Process -Force 只送出終止訊號，程序（尤其 chrome.exe
# 這類多子程序、或正被其他 shell 回收的程序）不會立刻從系統消失。上面的重試迴圈
# 可能在「剛送出最後一次終止」之後就結束，此時 $Remaining 仍是終止前拍下的快照；
# 直接拿它判定失敗，會把一個其實已經停好的 stop 誤報成失敗（exit 1）。
# 因此在判定成敗之前，重新查詢真正的狀態，並給程序一段有限、有界的寬限時間。
for ($Verify = 0; $Verify -lt 3; $Verify++) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave|chromium)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*" -or ([string]$_.CommandLine).IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    if ($Remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
}

# 上面迴圈最後一輪是「先睡、睡完不再查」：若程序剛好在那 300ms 內結束，
# 用來判定的快照仍是睡前拍的，會誤報 EGO_STOP_FAILED。判定前一律用即時查詢覆蓋。
if ($Remaining.Count -gt 0) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave|chromium)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*" -or ([string]$_.CommandLine).IndexOf($ProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
}

if ($Remaining.Count -gt 0) {
    Write-Output "EGO_STOP_FAILED (terminated $Stopped processes, $($Remaining.Count) still running)"
    exit 1
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
