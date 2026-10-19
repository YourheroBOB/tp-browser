param(
    [switch]$Headed,
    [switch]$Restart,
    [switch]$AltPort
)

$ErrorActionPreference = "SilentlyContinue"
$DataDir = Join-Path $HOME ".local\share\ego-linux"
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

# 2. Check if already healthy on target port (preserve existing headed desktop browser if -Headed and not -Restart)
if (-not $Restart) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$DaemonPort/health" -TimeoutSec 2
        $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 2
        if ($h.ok -and $h.chrome -and $cv.'User-Agent' -match 'Windows') {
            if (-not $Headed) {
                Write-Output "EGO_READY (port=$DaemonPort, chrome=$ChromePort, browser=$($cv.Browser))"
                exit 0
            } else {
                $HeadedProc = @(Get-CimInstance Win32_Process | Where-Object {
                    ($_.Name -match '^(chrome|msedge|brave)\.exe$') -and
                    ($_.CommandLine -like "*ego-linux*profile-agent*") -and
                    ($_.CommandLine -notlike "*--headless*") -and
                    ($_.SessionId -ge 1)
                })
                if ($HeadedProc.Count -gt 0) {
                    Write-Output "EGO_READY (port=$DaemonPort, chrome=$ChromePort, browser=$($cv.Browser), mode=headed, session=$($HeadedProc[0].SessionId))"
                    exit 0
                }
            }
        }
    } catch {}
}

# 3. Stop existing Windows TP Browser processes (only profile-agent & ego-browserd.js)
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 800

@("SingletonLock", "SingletonCookie", "SingletonSocket") | ForEach-Object {
    $lockPath = Join-Path $ProfileDir $_
    if (Test-Path $lockPath) { Remove-Item -Force $lockPath -ErrorAction SilentlyContinue }
}

# 4. Discover Windows Chromium-based browser binary (Chrome -> Edge -> Brave)
$BrowserBin = $env:TP_BROWSER_BIN
if (-not $BrowserBin -or -not (Test-Path $BrowserBin)) {
    $Candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
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

# 5. Discover Node.js binary & initialize profile (Bookmarks Bar + Favicons + Cookies)
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

# 6. Launch Chrome/Edge with CDP on $ChromePort
$CommonFlags = "--no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=$ChromePort `"--user-data-dir=$ProfileDir`" --window-size=1440,900 --disable-blink-features=AutomationControlled --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --noerrdialogs --disable-popup-blocking --disable-extensions --disable-features=msEdgeSidebarV2,msHub,msWelcomePage,Translate about:blank"
$CurrentSessionId = (Get-Process -Id $PID).SessionId

if (-not $Headed) {
    $ChromeCmdLine = "`"$BrowserBin`" --headless=new $CommonFlags"
    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $ChromeCmdLine } | Out-Null
} elseif ($CurrentSessionId -eq 0) {
    # Break out of Windows SSH Session 0 into the user's interactive desktop (Session 1+) via Task Scheduler (/IT)
    $GuiPs1 = Join-Path $DataDir "scripts\launch-headed-gui.ps1"
    New-Item -ItemType Directory -Force -Path (Split-Path $GuiPs1) | Out-Null
    $EscBrowser = $BrowserBin.Replace("'", "''")
    $EscFlags = $CommonFlags.Replace("'", "''")
    Set-Content -Path $GuiPs1 -Value "Start-Process -FilePath '$EscBrowser' -ArgumentList '$EscFlags'" -Encoding UTF8
    $TaskName = "TooPowerBrowserHeaded"
    $TaskTr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$GuiPs1`""
    & schtasks.exe /Create /TN $TaskName /TR $TaskTr /SC ONCE /ST 00:00 /IT /F 2>$null | Out-Null
    & schtasks.exe /Run /TN $TaskName 2>$null | Out-Null
} else {
    Start-Process -FilePath $BrowserBin -ArgumentList $CommonFlags | Out-Null
}

for ($i = 0; $i -lt 18; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 1
        if ($cv.webSocketDebuggerUrl) { break }
    } catch {}
}

# Fallback if schtasks /IT did not start Chrome (e.g. headless server with no interactive desktop logged in)
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

# 7. Launch ego-browserd.js via WMI Win32_Process.Create (detached from SSH/parent pipes)
$AltFlag = if ($UseAlt) { " --alt-port" } else { "" }
$DaemonCmdLine = "`"$NodeBin`" --experimental-websocket `"$DaemonJs`"$AltFlag"
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $DaemonCmdLine } | Out-Null

# 8. Wait up to 12s for daemon + chrome attachment
for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$DaemonPort/health" -TimeoutSec 1
        if ($h.ok -and $h.chrome) {
            $cv = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 1
            Write-Output "EGO_READY (port=$DaemonPort, chrome=$ChromePort, browser=$($cv.Browser), mode=$(if ($Headed) {'headed'} else {'headless'}))"
            exit 0
        }
    } catch {}
}

Write-Output "EGO_NOT_READY"
exit 1
