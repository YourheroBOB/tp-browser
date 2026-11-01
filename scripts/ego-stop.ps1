$ErrorActionPreference = "SilentlyContinue"
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$ProfileDir = Join-Path $DataDir "profile-agent"
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

# 目標程序認定規則：
# 1) 瀏覽器程序不再以 exe 名稱白名單判斷；只要 CommandLine 含
#    "--user-data-dir=" 且值就是本工具 ProfileDir 完整路徑就認定。
#    這不是任意子字串比對：路徑需完整相符，並以空白／引號／字串結尾收邊。
# 2) node 只認 daemon 腳本路徑。
function Test-EgoTargetProcess {
    param([string]$Name, [string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    if ($Name -match '^node\.exe$') {
        return ($CommandLine -like "*ego-browserd.js*" -or $CommandLine -like "*tp-browserd.js*")
    }
    $NormCmd = $CommandLine.Replace('/', '\')
    $NormProfile = $ProfileDir.Replace('/', '\')
    $Pattern = '(?i)--user-data-dir=(?:"' + [regex]::Escape($NormProfile) + '"|' + [regex]::Escape($NormProfile) + ')(?=[\s"]|$)'
    return [regex]::IsMatch($NormCmd, $Pattern)
}

$EgoTargetFilter = {
    Test-EgoTargetProcess $_.Name $_.CommandLine
}

$Stopped = 0
Get-CimInstance Win32_Process | Where-Object $EgoTargetFilter | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $Stopped++
}

$Remaining = @()
for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    $Remaining = @(Get-CimInstance Win32_Process | Where-Object $EgoTargetFilter)
    if ($Remaining.Count -eq 0) { break }
    foreach ($Proc in $Remaining) {
        Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
}

if ($Remaining.Count -gt 0) {
    Write-Output "EGO_STOP_FAILED (terminated $Stopped processes, $($Remaining.Count) still running)"
    exit 1
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
