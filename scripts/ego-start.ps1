param(
    [switch]$Headed,
    [switch]$Restart,
    [switch]$AltPort,
    [switch]$Edge,
    [switch]$Chrome
)

$ErrorActionPreference = "SilentlyContinue"
# same base dir node os.homedir() uses on Windows, so an isolated USERPROFILE isolates both
$HomeBase = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DataDir = Join-Path $HomeBase ".local\share\ego-linux"
$ProfileDir = Join-Path $DataDir "profile-agent"
$LogsDir = Join-Path $DataDir "logs"
$DaemonJs = Join-Path $DataDir "daemon\ego-browserd.js"

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

# 1. Determine port pair: 9772/9773 (default) vs 9774/9775 (if 9773 is occupied by WSL2 Linux Chrome)
$UseAlt = [bool]$AltPort
if (-not $UseAlt) {
    try {
        $v9773 = Invoke-RestMethod -Uri "http://127.0.0.1:9773/json/version" -TimeoutSec 2
        if ($v9773 -and $v9773.'User-Agent' -match 'Linux') {
            $UseAlt = $true
        }
    } catch {}
}

$DaemonPort = if ($UseAlt) { 9774 } else { 9772 }
$ChromePort = if ($UseAlt) { 9775 } else { 9773 }
# FIX-1151022 / RG-A7: explicit ports win so isolated instances never touch 9772
if ($env:EGO_BROWSERD_PORT) { $DaemonPort = [int]$env:EGO_BROWSERD_PORT }
if ($env:EGO_CHROME_PORT) { $ChromePort = [int]$env:EGO_CHROME_PORT }
$env:EGO_BROWSERD_PORT = "$DaemonPort"; $env:EGO_CHROME_PORT = "$ChromePort"
. (Join-Path $PSScriptRoot "tp-proc.ps1")

# 2. Discover preferred Windows Chromium-based browser binary (Edge vs Chrome)
$BrowserBin = $env:TP_BROWSER_BIN
if (-not $BrowserBin -or -not (Test-Path $BrowserBin)) {
    $ChromePaths = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $EdgePaths = @(
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
    $BravePaths = @(
        "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
    )

    $PreferEdge = [bool]$Edge
    if (-not $Edge -and -not $Chrome) {
        $EdgeBm = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data\Default\Bookmarks"
        $ChromeBm = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Bookmarks"
        $EdgeSz = if (Test-Path $EdgeBm) { (Get-Item $EdgeBm).Length } else { 0 }
        $ChromeSz = if (Test-Path $ChromeBm) { (Get-Item $ChromeBm).Length } else { 0 }
        if ($EdgeSz -gt $ChromeSz) { $PreferEdge = $true }
    }

    $Candidates = if ($PreferEdge) { $EdgePaths + $ChromePaths + $BravePaths } else { $ChromePaths + $EdgePaths + $BravePaths }
    foreach ($c in $Candidates) {
        if ($c -and (Test-Path $c)) {
            $BrowserBin = $c
            break
        }
    }
}

if (-not $BrowserBin -or -not (Test-Path $BrowserBin)) {
    Write-Error "ERROR: No Chrome or Edge binary found on this Windows machine!"
    exit 1
}
$TargetExeName = Split-Path $BrowserBin -Leaf

# 3. Check if already healthy on target port (preserve existing interactive headed desktop browser if -Headed and not -Restart)
if (-not $Restart) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$DaemonPort/health" -TimeoutSec 2
        $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 2
        if ($h.ok -and $h.chrome -and $cv.'User-Agent' -match 'Windows') {
            if (-not $Headed -and -not $Edge -and -not $Chrome) {
                Write-Output "EGO_READY (port=$DaemonPort, chrome=$ChromePort, browser=$($cv.Browser))"
                exit 0
            } elseif ($Headed) {
                $HeadedProc = @(Get-CimInstance Win32_Process | Where-Object {
                    ($_.Name -ieq $TargetExeName) -and
                    ($_.CommandLine -like "*--user-data-dir=$ProfileDir*") -and
                    ($_.CommandLine -like "*--tp-interactive-gui=1*") -and
                    ($_.CommandLine -notlike "*--headless*") -and
                    ($_.SessionId -ge 1)
                })
                if ($HeadedProc.Count -gt 0) {
                    $tabs = @(Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/list" -TimeoutSec 2 | Where-Object { $_.type -eq 'page' } | ForEach-Object { $_.title })
                    Write-Output "EGO_READY (port=$DaemonPort, chrome=$ChromePort, browser=$($cv.Browser), exe=$TargetExeName, pid=$($HeadedProc[0].ProcessId), session=$($HeadedProc[0].SessionId), mode=headed)"
                    Write-Output "TP_INDICATORS: [1] Tab Title Prefix: ⚡[TP] | [2] Top 4px Gold-Green Strip | [3] Bottom-Right ⚡ TooPower Capsule | Active Tabs: $($tabs -join ' ; ')"
                    exit 0
                }
            }
        }
    } catch {}
}

# 4. Flush active cookies & storage and gracefully close browser via CDP before stopping processes
Invoke-TpFlushClose $DataDir $DaemonPort
Start-Sleep -Milliseconds 1000

# RG-A7: stop only this instance's processes
$null = Stop-TpScoped $DataDir $ProfileDir $DaemonPort
Start-Sleep -Milliseconds 800

@("SingletonLock", "SingletonCookie", "SingletonSocket") | ForEach-Object {
    $lockPath = Join-Path $ProfileDir $_
    if (Test-Path $lockPath) { Remove-Item -Force $lockPath -ErrorAction SilentlyContinue }
}

# 5. Discover Node.js binary & initialize profile (Bookmarks Bar + Favicons)
$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) {
    foreach ($nc in @("C:\Program Files\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $nc) { $NodeBin = $nc; break }
    }
}
if (-not $NodeBin) {
    Write-Error "ERROR: node.exe not found!"
    exit 1
}

$ProfileInitJs = Join-Path $DataDir "tools\profile-init.js"
if (-not (Test-Path $ProfileInitJs)) {
    $ProfileInitJs = Join-Path (Split-Path $PSScriptRoot -Parent) "tools\profile-init.js"
}
if (Test-Path $ProfileInitJs) {
    & $NodeBin $ProfileInitJs 2>$null | Out-Null
}

# 6. Launch ego-browserd.js FIRST so http://127.0.0.1:$DaemonPort/newtab is ready before browser window opens
$AltFlag = if ($UseAlt) { " --alt-port" } else { "" }
$DaemonCmdLine = "`"$NodeBin`" --experimental-websocket `"$DaemonJs`"$AltFlag"
$DaemonPid = (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $DaemonCmdLine }).ProcessId
Start-Sleep -Milliseconds 400

# 7. Launch Chrome/Edge with CDP on $ChromePort
$StartUrl = if ($Headed) { "http://127.0.0.1:$DaemonPort/newtab" } else { "about:blank" }
$GuiMarker = if ($Headed) { " --tp-interactive-gui=1" } else { " --disable-extensions" }
$CommonFlags = "--no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=$ChromePort `"--user-data-dir=$ProfileDir`" --window-size=1440,900 --disable-blink-features=AutomationControlled --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --noerrdialogs --disable-popup-blocking --disable-quic --disable-features=msEdgeSidebarV2,msHub,msWelcomePage,Translate$GuiMarker $StartUrl"
$CurrentSessionId = (Get-Process -Id $PID).SessionId

if (-not $Headed) {
    $ChromeCmdLine = "`"$BrowserBin`" --headless=new $CommonFlags"
    $BrowserPid = (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $ChromeCmdLine }).ProcessId
} elseif ($CurrentSessionId -eq 0) {
    # Break out of Windows SSH Session 0 into the user's interactive desktop (Session 1+) via Task Scheduler (/IT)
    $GuiPs1 = Join-Path $DataDir "scripts\launch-headed-gui.ps1"
    New-Item -ItemType Directory -Force -Path (Split-Path $GuiPs1) | Out-Null
    $EscBrowser = $BrowserBin.Replace("'", "''")
    $EscFlags = $CommonFlags.Replace("'", "''")
    Set-Content -Path $GuiPs1 -Value "Start-Process -FilePath '$EscBrowser' -ArgumentList '$EscFlags' -WindowStyle Normal" -Encoding UTF8
    $TaskName = "TooPowerBrowserHeaded"
    $TaskTr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$GuiPs1`""
    & schtasks.exe /Create /TN $TaskName /TR $TaskTr /SC ONCE /ST 00:00 /IT /F 2>$null | Out-Null
    & schtasks.exe /Run /TN $TaskName 2>$null | Out-Null
} else {
    $BrowserPid = (Start-Process -FilePath $BrowserBin -ArgumentList $CommonFlags -WindowStyle Normal -PassThru).Id
}
Set-Content -Path (Join-Path $DataDir "tp-pids-$DaemonPort") -Value @("daemon=$DaemonPid", "chrome=$BrowserPid") -Encoding ASCII

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 1
        if ($cv.webSocketDebuggerUrl) { break }
    } catch {}
}

# Fallback if schtasks /IT did not start Chrome/Edge (e.g. headless server with no interactive desktop logged in)
try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 1
} catch {
    if ($Headed -and $CurrentSessionId -eq 0) {
        Start-Process -FilePath $BrowserBin -ArgumentList $CommonFlags | Out-Null
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 1
                if ($cv.webSocketDebuggerUrl) { break }
            } catch {}
        }
    }
}

if ($Headed -and $CurrentSessionId -eq 0) {
    & schtasks.exe /Delete /TN "TooPowerBrowserHeaded" /F 2>$null | Out-Null
}

# 8. Wait up to 12s for daemon + chrome attachment and print verification indicators
for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$DaemonPort/health" -TimeoutSec 1
        if ($h.ok -and $h.chrome) {
            $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 1
            $ProcInfo = @(Get-CimInstance Win32_Process | Where-Object {
                ($_.Name -ieq $TargetExeName) -and ($_.CommandLine -like "*--user-data-dir=$ProfileDir*") -and ($_.CommandLine -notlike "*--type=*")
            })
            $MainPid = if ($ProcInfo.Count -gt 0) { $ProcInfo[0].ProcessId } else { 0 }
            $MainSess = if ($ProcInfo.Count -gt 0) { $ProcInfo[0].SessionId } else { -1 }
            $tabs = @(Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/list" -TimeoutSec 2 | Where-Object { $_.type -eq 'page' } | ForEach-Object { $_.title })
            Write-Output "EGO_READY (port=$DaemonPort, chrome=$ChromePort, browser=$($cv.Browser), exe=$TargetExeName, pid=$MainPid, session=$MainSess, mode=$(if ($Headed) {'headed'} else {'headless'}))"
            if ($Headed) {
                Write-Output "TP_INDICATORS: [1] Tab Title Prefix: ⚡[TP] | [2] Top 4px Gold-Green Strip | [3] Bottom-Right ⚡ TooPower Capsule | Active Tabs: $($tabs -join ' ; ')"
            }
            exit 0
        }
    } catch {}
}

Write-Output "EGO_NOT_READY"
exit 1
