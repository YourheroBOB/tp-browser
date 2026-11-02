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

# "What EGO owns" is defined exactly once, so the first sweep, the retry loop and
# the final verdict can never drift apart about which processes are targets.
function Get-EgoProcess {
    @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
    })
}

$Stopped = 0
foreach ($Proc in @(Get-EgoProcess)) {
    Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
    $Stopped++
}

# Stop-Process only queues the termination: the process keeps showing up in the
# Win32_Process snapshot until the kernel reaps it. The old loop therefore reported
# its verdict from the sample taken *before* the last kill, so a process that
# disappeared during the final 300 ms wait was still counted as "remaining" and the
# script printed EGO_STOP_FAILED / exit 1 for a stop that had already succeeded.
$Remaining = @(Get-EgoProcess)
for ($Attempt = 0; $Attempt -lt 10 -and $Remaining.Count -gt 0; $Attempt++) {
    Start-Sleep -Milliseconds 300
    $Remaining = @(Get-EgoProcess)
    if ($Remaining.Count -eq 0) { break }
    foreach ($Proc in $Remaining) {
        Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Out of retries: give the last kill one bounded window and take a fresh sample,
# so the verdict is never based on a pre-kill snapshot.
if ($Remaining.Count -gt 0) {
    Start-Sleep -Milliseconds 300
    $Remaining = @(Get-EgoProcess)
}

if ($Remaining.Count -gt 0) {
    Write-Output "EGO_STOP_FAILED (terminated $Stopped processes, $($Remaining.Count) still running)"
    exit 1
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
