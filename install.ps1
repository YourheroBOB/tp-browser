$ErrorActionPreference = "Stop"
$ScriptPath = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $PWD.Path }
$TempClone = $null
if ((Test-Path (Join-Path $ScriptPath "bin\tp-browser.js")) -and (Test-Path (Join-Path $ScriptPath "daemon\ego-browserd.js"))) {
    $RepoRoot = $ScriptPath
} else {
    Write-Output "=== [0] Downloading TooPower Browser (tp-browser) from GitHub ==="
    $TempClone = Join-Path ([System.IO.Path]::GetTempPath()) ("tp-browser-install-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    & git clone --depth 1 https://github.com/YourheroBOB/tp-browser.git $TempClone
    $RepoRoot = $TempClone
}
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$InstallDir = Join-Path $HOME "ego-linux-install"
$LocalBin = Join-Path $HOME ".local\bin"
$HomeBin = Join-Path $HOME "bin"

Write-Output "=== [1] Installing TooPower Browser (tp-browser / ego-win) to $DataDir ==="
New-Item -ItemType Directory -Force -Path $DataDir, $InstallDir, $LocalBin, $HomeBin, (Join-Path $DataDir "profile-agent") | Out-Null
try { & icacls $DataDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null } catch {}

foreach ($d in @("bin", "daemon", "lib", "scripts", "tools", "tests", "skills")) {
    $src = Join-Path $RepoRoot $d
    if (Test-Path $src) {
        $dstData = Join-Path $DataDir $d
        $dstInst = Join-Path $InstallDir $d
        if (Test-Path $dstData) { Remove-Item -Recurse -Force $dstData }
        if (Test-Path $dstInst) { Remove-Item -Recurse -Force $dstInst }
        Copy-Item -Recurse -Force $src $dstData
        Copy-Item -Recurse -Force $src $dstInst
    }
}

# Auto-install universal AI Agent Skill (Claude Code, Antigravity, Cursor, Codex, OpenClaw)
$SkillSrc = Join-Path $DataDir "skills\tp-browser\SKILL.md"
if (Test-Path $SkillSrc) {
    foreach ($sBase in @((Join-Path $HOME ".claude\skills"), (Join-Path $HOME ".agents\skills"), (Join-Path $HOME ".codex\skills"))) {
        foreach ($sName in @("tp-browser", "ego-browser")) {
            $sRoot = Join-Path $sBase $sName
            New-Item -ItemType Directory -Force -Path $sRoot | Out-Null
            Copy-Item -Force $SkillSrc (Join-Path $sRoot "SKILL.md")
            # RG-A9b: SKILL.md links to references\*.md; install them too.
            $RefSrc = Join-Path $DataDir "skills\tp-browser\references"
            if (Test-Path $RefSrc) {
                $RefDst = Join-Path $sRoot "references"
                New-Item -ItemType Directory -Force -Path $RefDst | Out-Null
                Copy-Item -Force (Join-Path $RefSrc "*.md") $RefDst
            }
        }
    }
    Write-Output "Installed AI Agent Skill (SKILL.md) to ~/.claude/skills, ~/.agents/skills, ~/.codex/skills (tp-browser + ego-browser)"
}
if ($TempClone -and (Test-Path $TempClone)) { Remove-Item -Recurse -Force $TempClone -ErrorAction SilentlyContinue }

# Create CMD & Sh wrappers in ~/.local/bin and ~/bin
$CmdWrapper = @'
@echo off
if /I "%~1"=="start" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-start.ps1"
    exit /b %ERRORLEVEL%
)
if /I "%~1"=="restart" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-start.ps1" -Restart
    exit /b %ERRORLEVEL%
)
if /I "%~1"=="headed" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-start.ps1" -Headed
    exit /b %ERRORLEVEL%
)
if /I "%~1"=="stop" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-stop.ps1"
    exit /b %ERRORLEVEL%
)
node --experimental-websocket "%USERPROFILE%\.local\share\ego-linux\bin\ego-browser.js" %*
'@

$ShWrapper = @'
#!/bin/sh
exec node --experimental-websocket "$HOME/.local/share/ego-linux/bin/ego-browser.js" "$@"
'@

$StartCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-start.ps1" %*
'@

$HeadedCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-start.ps1" -Headed %*
'@

$StopCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-stop.ps1" %*
'@

foreach ($dir in @($LocalBin, $HomeBin)) {
    Set-Content -Path (Join-Path $dir "ego-browser.cmd") -Value $CmdWrapper -Encoding Ascii
    Set-Content -Path (Join-Path $dir "tp-browser.cmd") -Value $CmdWrapper -Encoding Ascii
    Set-Content -Path (Join-Path $dir "ego-browser") -Value $ShWrapper -Encoding Ascii -NoNewline
    Set-Content -Path (Join-Path $dir "tp-browser") -Value $ShWrapper -Encoding Ascii -NoNewline
    Set-Content -Path (Join-Path $dir "ego-start.cmd") -Value $StartCmd -Encoding Ascii
    Set-Content -Path (Join-Path $dir "tp-start.cmd") -Value $StartCmd -Encoding Ascii
    Set-Content -Path (Join-Path $dir "ego-headed.cmd") -Value $HeadedCmd -Encoding Ascii
    Set-Content -Path (Join-Path $dir "tp-headed.cmd") -Value $HeadedCmd -Encoding Ascii
    Set-Content -Path (Join-Path $dir "ego-stop.cmd") -Value $StopCmd -Encoding Ascii
    Set-Content -Path (Join-Path $dir "tp-stop.cmd") -Value $StopCmd -Encoding Ascii
}

# Ensure ~/.local/bin and ~/bin are in User PATH.
# RG-A10b: read/write the raw registry value so REG_EXPAND_SZ entries such as %JAVA_HOME%\bin stay unexpanded,
# and record exactly which entries TP added so uninstall.ps1 removes only those.
function Send-TpEnvBroadcast {
    # RG-A10c: tell Explorer and new processes that User PATH changed (SetEnvironmentVariable did this implicitly).
    try {
        if (-not ("TpNs.EnvNotify" -as [type])) {
            Add-Type -Namespace "TpNs" -Name "EnvNotify" -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' -ErrorAction Stop
        }
        $r = [UIntPtr]::Zero
        [void][TpNs.EnvNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r)
    } catch { }
}
# >>> TP_PATH_BLOCK (tests/isolated/a10-win-path.ps1 runs this block against a throwaway HKCU\Software\TP-test-* key)
$EnvSubKey = "Environment"
if ($env:TP_TEST_ENV_SUBKEY -and ($env:TP_TEST_ENV_SUBKEY -match '^Software\\TP-test-[A-Za-z0-9-]+\\Environment$')) { $EnvSubKey = $env:TP_TEST_ENV_SUBKEY }
$EnvKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($EnvSubKey)
$UserPath = [string]$EnvKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$PathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
try { $PathKind = $EnvKey.GetValueKind("Path") } catch { }
$PathParts = @($UserPath -split ";" | Where-Object { $_ -ne "" })
$Added = @()
$Managed = @()
foreach ($b in @($LocalBin, $HomeBin)) {
    $present = $PathParts | Where-Object { ($_.TrimEnd('\') -ieq $b.TrimEnd('\')) -or ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $b.TrimEnd('\')) }
    if (-not $present) {
        $PathParts += $b
        $Added += $b
    }
    $Managed += $b
}
if ($Added.Count -gt 0) {
    $EnvKey.SetValue("Path", ($PathParts -join ";"), $PathKind)
    $env:Path = "$LocalBin;$HomeBin;$env:Path"
    Send-TpEnvBroadcast
}
# RG-A10d: record only the entries this installer actually appended; entries that were already on PATH
# (raw or via %VAR%) belong to the user and uninstall never removes them.
if ($Added.Count -gt 0) {
    # RG-A10e: v2 marker. Pre-v2 path-added.txt may list entries the user already had, so it is never merged.
    $Marker = Join-Path $DataDir "path-added.v2.txt"
    $prevAdded = @()
    if (Test-Path -LiteralPath $Marker) { $prevAdded = @(Get-Content -LiteralPath $Marker | Where-Object { $_ -ne "" }) }
    Set-Content -LiteralPath $Marker -Value (@($prevAdded + $Added) | Select-Object -Unique) -Encoding UTF8
}
$EnvKey.Close()
# <<< TP_PATH_BLOCK

# Install Startup VBS launcher so TP Browser auto-starts hidden on Windows logon
$StartupDir = [Environment]::GetFolderPath("Startup")
if ($StartupDir -and (Test-Path $StartupDir)) {
    $VbsPath = Join-Path $StartupDir "tp-browser-autostart.vbs"
    $StartPs1 = Join-Path $DataDir "scripts\ego-start.ps1"
    $VbsContent = "Set WshShell = CreateObject(`"WScript.Shell`")`r`nWshShell.Run `"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"`"$StartPs1`"`"`", 0, False`r`n"
    Set-Content -Path $VbsPath -Value $VbsContent -Encoding Ascii
    Write-Output "Installed Windows Startup launcher: $VbsPath"
}

# TP_NO_START=1 skips launching the browser and daemon (isolated installs / tests).
if ($env:TP_NO_START -eq "1") {
    Write-Output "=== [2] TP_NO_START=1, skipped starting TP ==="
} else {
    Write-Output "=== [2] Starting TP Browser Service ==="
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DataDir "scripts\ego-start.ps1")
    & (Join-Path $LocalBin "ego-browser.cmd") version
    & (Join-Path $LocalBin "ego-browser.cmd") status
}
