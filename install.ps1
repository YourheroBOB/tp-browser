$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $HOME ".local\share\ego-linux"
$InstallDir = Join-Path $HOME "ego-linux-install"
$LocalBin = Join-Path $HOME ".local\bin"
$HomeBin = Join-Path $HOME "bin"

Write-Output "=== [1] Installing TooPower Browser (tp-browser / ego-win) to $DataDir ==="
New-Item -ItemType Directory -Force -Path $DataDir, $InstallDir, $LocalBin, $HomeBin, (Join-Path $DataDir "profile-agent") | Out-Null
try { & icacls $DataDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null } catch {}

foreach ($d in @("bin", "daemon", "lib", "scripts", "tools", "tests")) {
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
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-start.ps1" -Headed
'@

$StopCmd = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.local\share\ego-linux\scripts\ego-stop.ps1"
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

# Ensure ~/.local/bin and ~/bin are in User PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $UserPath) { $UserPath = "" }
$PathParts = $UserPath -split ";" | Where-Object { $_ -ne "" }
$Modified = $false
foreach ($b in @($LocalBin, $HomeBin)) {
    if ($PathParts -notcontains $b) {
        $PathParts += $b
        $Modified = $true
    }
}
if ($Modified) {
    [Environment]::SetEnvironmentVariable("Path", ($PathParts -join ";"), "User")
    $env:Path = "$LocalBin;$HomeBin;$env:Path"
}

# Install Startup VBS launcher so TP Browser auto-starts hidden on Windows logon
$StartupDir = [Environment]::GetFolderPath("Startup")
if ($StartupDir -and (Test-Path $StartupDir)) {
    $VbsPath = Join-Path $StartupDir "tp-browser-autostart.vbs"
    $StartPs1 = Join-Path $DataDir "scripts\ego-start.ps1"
    $VbsContent = "Set WshShell = CreateObject(`"WScript.Shell`")`r`nWshShell.Run `"powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"`"$StartPs1`"`"`", 0, False`r`n"
    Set-Content -Path $VbsPath -Value $VbsContent -Encoding Ascii
    Write-Output "Installed Windows Startup launcher: $VbsPath"
}

Write-Output "=== [2] Starting TP Browser Service ==="
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DataDir "scripts\ego-start.ps1")
& (Join-Path $LocalBin "ego-browser.cmd") version
& (Join-Path $LocalBin "ego-browser.cmd") status
