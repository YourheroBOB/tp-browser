$ErrorActionPreference = "SilentlyContinue"
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$Ports = @(9772, 9774)
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
$Stopped = 0
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $Stopped++
}

$Remaining = @()
for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
    })
    if ($Remaining.Count -eq 0) { break }
    foreach ($Proc in $Remaining) {
        Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
}

# 強制終止是非同步的：Stop-Process -Force 只送出終止訊號，程序（尤其 chrome.exe
# 這類多子程序、或正被其他 shell 回收的程序）不會立刻從系統消失。上面的重試迴圈
# 可能在「剛送出最後一次終止」之後就結束，此時 $Remaining 仍是終止前拍下的快照；
# 直接拿它判定失敗，會把一個其實已經停好的 stop 誤報成失敗（exit 1）。
# 因此在判定成敗之前，重新查詢真正的狀態，並給程序一段有限、有界的寬限時間。
# 注意：最後一輪（$Verify = 3）只查、不再睡。舊寫法是每一輪都先查再「無條件」睡
# 300ms，於是當最後一輪仍查到程序時，迴圈會先睡完才結束，接著卻拿「睡前」的快照
# 判定失敗（exit 1）——最後一次 300ms 的寬限等於白等，且會把寬限期內其實已停好的
# stop 誤報成停止失敗。現在判定用的永遠是最後一次查詢的最新快照。
for ($Verify = 0; $Verify -lt 4; $Verify++) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
    })
    if ($Remaining.Count -eq 0) { break }
    if ($Verify -lt 3) { Start-Sleep -Milliseconds 300 }
}

if ($Remaining.Count -gt 0) {
    Write-Output "EGO_STOP_FAILED (terminated $Stopped processes, $($Remaining.Count) still running)"
    exit 1
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
