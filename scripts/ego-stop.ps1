$ErrorActionPreference = "SilentlyContinue"
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$Ports = @(9772, 9774)
$DaemonJson = Join-Path $DataDir "daemon.json"
if (Test-Path $DaemonJson) {
    try {
        $Cfg = Get-Content -Raw -Path $DaemonJson | ConvertFrom-Json
        if ($Cfg.port) {
            # [int] 會把 true 收成 1，也會把 18802.9 這類 Double 四捨五入成別的埠。
            # Windows PowerShell 5.1 的 ConvertFrom-Json 又把所有 JSON 數字讀成 Double，
            # 所以只能擋「非整數」，整數值的 Double（例如 18802.0）仍要放行。
            $RawPort = $Cfg.port
            $RejectPort = $false
            if ($RawPort -is [bool]) {
                $RejectPort = $true
            } elseif (($RawPort -is [double]) -or ($RawPort -is [float]) -or ($RawPort -is [decimal])) {
                if ($RawPort -ne [math]::Truncate($RawPort)) { $RejectPort = $true }
            }
            if (-not $RejectPort) {
                $CfgPort = [int]$Cfg.port
                if ($CfgPort -ge 1 -and $CfgPort -le 65535 -and $Ports -notcontains $CfgPort) { $Ports += $CfgPort }
            }
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
# 終止數必須寫進腳本範圍。管線 ForEach-Object 在 Windows PowerShell 5.1 是子範圍，
# 裸的遞增只會改到子範圍，訊息會永遠顯示 terminated 0。
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $script:Stopped++
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
for ($Verify = 0; $Verify -lt 3; $Verify++) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
    })
    if ($Remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
}

if ($Remaining.Count -gt 0) {
    Write-Output "EGO_STOP_FAILED (terminated $Stopped processes, $($Remaining.Count) still running)"
    exit 1
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
