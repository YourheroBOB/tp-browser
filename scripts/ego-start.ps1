param(
    [switch]$Headed,
    [switch]$Restart,
    [switch]$AltPort,
    [switch]$Edge,
    [switch]$Chrome
)

$ErrorActionPreference = "SilentlyContinue"
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$ProfileDir = Join-Path $DataDir "profile-agent"
$LogsDir = Join-Path $DataDir "logs"
$DaemonJs = Join-Path $DataDir "daemon\ego-browserd.js"
if (-not (Test-Path $DaemonJs)) {
    $DaemonJs = Join-Path (Split-Path $PSScriptRoot -Parent) "daemon\ego-browserd.js"
}

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

# 2. Discover preferred Windows Chromium-based browser binary (Edge vs Chrome)
#    Fail loudly instead of silently switching browsers: an explicitly configured
#    TP_BROWSER_BIN must exist, and -Edge / -Chrome restrict the search to that
#    browser's own path list. All of these checks run BEFORE any flush-and-close
#    or Stop-Process below, so a wrong browser never touches a live profile.
#    A folder (e.g. ...\Chrome\Application) or a non-.exe file also passes a bare
#    Test-Path, and launching it opens Explorer / fails Win32_Process Create only
#    after the running daemon and browser were already killed.
function Get-BrowserBinProblem([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return "is empty" }
    try {
        if (Test-Path -LiteralPath $Path -PathType Container -ErrorAction SilentlyContinue) {
            return "is a directory, not a browser executable"
        }
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction SilentlyContinue)) {
            return "does not exist"
        }
    } catch {
        return "does not exist"
    }
    if ([System.IO.Path]::GetExtension($Path) -ine ".exe") {
        return "is not an .exe file"
    }
    return $null
}

function Test-BrowserBinPath([string]$Path) {
    return ($null -eq (Get-BrowserBinProblem -Path $Path))
}

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

$BrowserBin = $env:TP_BROWSER_BIN
if (-not ([string]::IsNullOrWhiteSpace($BrowserBin))) {
    if (-not (Test-BrowserBinPath -Path $BrowserBin)) {
        $BinProblem = Get-BrowserBinProblem -Path $BrowserBin
        [Console]::Error.WriteLine("ERROR: TP_BROWSER_BIN is set to '$BrowserBin' but that path $BinProblem. No Chrome or Edge binary is available at TP_BROWSER_BIN; refusing to fall back to a different browser.")
        exit 1
    }
} elseif ($Edge -and $Chrome) {
    [Console]::Error.WriteLine("ERROR: -Edge and -Chrome must not be combined; refusing to guess which browser profile to open.")
    exit 1
} elseif ($Edge -or $Chrome) {
    $ExplicitBrowser = if ($Edge) { "Edge" } else { "Chrome" }
    $ExplicitPaths = if ($Edge) { $EdgePaths } else { $ChromePaths }
    foreach ($c in $ExplicitPaths) {
        if (Test-BrowserBinPath -Path $c) {
            $BrowserBin = $c
            break
        }
    }
    if (-not (Test-BrowserBinPath -Path $BrowserBin)) {
        [Console]::Error.WriteLine("ERROR: -$ExplicitBrowser was requested but no $ExplicitBrowser .exe binary was found in its known install paths (directories and non-.exe files are rejected); refusing to fall back to a different browser.")
        exit 1
    }
} else {
    $PreferEdge = $false
    $EdgeBm = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data\Default\Bookmarks"
    $ChromeBm = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Bookmarks"
    $EdgeSz = if (Test-Path $EdgeBm) { (Get-Item $EdgeBm).Length } else { 0 }
    $ChromeSz = if (Test-Path $ChromeBm) { (Get-Item $ChromeBm).Length } else { 0 }
    if ($EdgeSz -gt $ChromeSz) { $PreferEdge = $true }

    $Candidates = if ($PreferEdge) { $EdgePaths + $ChromePaths + $BravePaths } else { $ChromePaths + $EdgePaths + $BravePaths }
    foreach ($c in $Candidates) {
        if (Test-BrowserBinPath -Path $c) {
            $BrowserBin = $c
            break
        }
    }
    if (-not (Test-BrowserBinPath -Path $BrowserBin)) {
        [Console]::Error.WriteLine("ERROR: No Chrome or Edge binary found on this Windows machine!")
        exit 1
    }
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
                    ($_.CommandLine -like "*ego-linux*profile-agent*") -and
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

# 3b. Preflight: discover the Node.js binary BEFORE the flush / Stop-Process sweep below.
#     node.exe is required to run ego-browserd.js, so a missing node must fail here instead of
#     after the running daemon and browser were already killed (the live profile is only touched
#     once we know the replacement stack can actually be started).
$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) {
    foreach ($nc in @("C:\Program Files\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $nc) { $NodeBin = $nc; break }
    }
}
if (-not $NodeBin) {
    [Console]::Error.WriteLine("ERROR: node.exe not found!")
    exit 1
}

# 4. Flush active cookies & storage and gracefully close browser via CDP before stopping processes.
#    The Stop-Process sweep below terminates EVERY ego daemon, including a stale one still
#    sitting on the other port pair (9772 vs 9774). Flushing only the port we are about to
#    start left that other stack's Chrome to be hard-killed by Stop-Process -Force, which can
#    lose the cookie / storage state the user just created there. So flush both default ports
#    before the sweep; -AltPort still gets its 9774 flush from this same list.
foreach ($FlushPort in @(9772, 9774)) {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$FlushPort/flush-and-close" -TimeoutSec 3 | Out-Null } catch {}
}
Start-Sleep -Milliseconds 1000

Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-EgoProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
        ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*tp-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
    })
}

# Stop-Process only requests termination. A browser that has not exited yet still
# holds the profile, so deleting its Singleton lock and launching a second browser
# fails; wait up to ~5s and never touch the lock while anything is left.
$Remaining = @()
for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
    Start-Sleep -Milliseconds 250
    $Remaining = @(Get-EgoProcesses)
    if ($Remaining.Count -eq 0) { break }
    foreach ($Proc in $Remaining) {
        Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
if ($Remaining.Count -gt 0) {
    Write-Output "EGO_NOT_READY (profile still in use)"
    exit 1
}

@("SingletonLock", "SingletonCookie", "SingletonSocket") | ForEach-Object {
    $lockPath = Join-Path $ProfileDir $_
    if (Test-Path $lockPath) { Remove-Item -Force $lockPath -ErrorAction SilentlyContinue }
}

# 5. Initialize profile (Bookmarks Bar + Favicons)
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
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $DaemonCmdLine } | Out-Null
Start-Sleep -Milliseconds 400

# 7. Launch Chrome/Edge with CDP on $ChromePort
$StartUrl = if ($Headed) { "http://127.0.0.1:$DaemonPort/newtab" } else { "about:blank" }
$GuiMarker = if ($Headed) { " --tp-interactive-gui=1" } else { " --disable-extensions" }
$CommonFlags = "--no-first-run --no-default-browser-check --remote-debugging-address=127.0.0.1 --remote-debugging-port=$ChromePort `"--user-data-dir=$ProfileDir`" --window-size=1440,900 --disable-blink-features=AutomationControlled --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --noerrdialogs --disable-popup-blocking --disable-quic --disable-features=msEdgeSidebarV2,msHub,msWelcomePage,Translate$GuiMarker $StartUrl"
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
    Set-Content -Path $GuiPs1 -Value "Start-Process -FilePath '$EscBrowser' -ArgumentList '$EscFlags' -WindowStyle Normal" -Encoding UTF8
    $TaskName = "TooPowerBrowserHeaded"
    $TaskTr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$GuiPs1`""
    & schtasks.exe /Create /TN $TaskName /TR $TaskTr /SC ONCE /ST 00:00 /IT /F 2>$null | Out-Null
    & schtasks.exe /Run /TN $TaskName 2>$null | Out-Null
} else {
    Start-Process -FilePath $BrowserBin -ArgumentList $CommonFlags -WindowStyle Normal | Out-Null
}

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
                ($_.Name -ieq $TargetExeName) -and ($_.CommandLine -like "*ego-linux*profile-agent*") -and ($_.CommandLine -notlike "*--type=*")
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
