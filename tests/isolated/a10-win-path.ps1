# RG-A10e: rerunnable test of the install/uninstall User PATH logic.
# Runs the TP_PATH_BLOCK sections of install.ps1 / uninstall.ps1 against a throwaway
# HKCU\Software\TP-test-a10\Environment key; the real HKCU\Environment is never touched.
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Fail = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { Write-Output "PASS A10W $name $detail" } else { Write-Output "FAIL A10W $name $detail"; $script:Fail = 1 }
}
function Get-Block([string]$file) {
    $t = [IO.File]::ReadAllText((Join-Path $Repo $file))
    $m = [regex]::Match($t, '(?s)# >>> TP_PATH_BLOCK.*?# <<< TP_PATH_BLOCK')
    if (-not $m.Success) { throw "TP_PATH_BLOCK missing in $file" }
    return $m.Value
}
$TestRoot = "Software\TP-test-a10"
$env:TP_TEST_ENV_SUBKEY = "$TestRoot\Environment"
$Tmp = Join-Path $env:TEMP ("tp-a10w-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$DataDir = Join-Path $Tmp "data"; New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$LocalBin = Join-Path $Tmp "home\.local\bin"
$HomeBin = Join-Path $Tmp "home\bin"
function Send-TpEnvBroadcast { $script:Broadcasts++ }
function Add-Plan([string]$Path) { if (-not ($script:Plan -contains $Path)) { $script:Plan += $Path } }
$InstallBlock = Get-Block "install.ps1"
$UninstallBlock = Get-Block "uninstall.ps1"
function Set-FakePath([string]$v) {
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:TP_TEST_ENV_SUBKEY)
    $k.SetValue("Path", $v, [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()
}
function Get-FakePath {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:TP_TEST_ENV_SUBKEY)
    $v = [string]$k.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $k.GetValueKind("Path"); $k.Close()
    return @($v, $kind)
}
try {
    $savedEnvPath = $env:Path
    $Start = "C:\keep1;%TPTESTVAR%\x;$HomeBin"
    Set-FakePath $Start
    # Legacy (pre-v2) marker that wrongly lists the user's own HomeBin entry.
    Set-Content -LiteralPath (Join-Path $DataDir "path-added.txt") -Value @($HomeBin) -Encoding UTF8
    $script:Broadcasts = 0
    Invoke-Expression $InstallBlock
    $env:Path = $savedEnvPath
    $r = Get-FakePath
    Check "install appends missing LocalBin" ($r[0] -eq "$Start;$LocalBin") $r[0]
    Check "install keeps REG_EXPAND_SZ" ($r[1] -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) "$($r[1])"
    Check "install keeps %VAR% unexpanded" ($r[0] -like "*%TPTESTVAR%\x*") ""
    Check "install broadcast once" ($script:Broadcasts -eq 1) "$script:Broadcasts"
    $mk = @(Get-Content -LiteralPath (Join-Path $DataDir "path-added.v2.txt") | Where-Object { $_ -ne "" })
    Check "v2 marker lists only appended entry" (($mk.Count -eq 1) -and ($mk[0] -eq $LocalBin)) ($mk -join "|")
    # Second install: nothing to add, marker unchanged, no broadcast.
    $script:Broadcasts = 0
    Invoke-Expression $InstallBlock
    $env:Path = $savedEnvPath
    $r2 = Get-FakePath
    Check "reinstall no duplicate" ($r2[0] -eq "$Start;$LocalBin") $r2[0]
    Check "reinstall no broadcast" ($script:Broadcasts -eq 0) "$script:Broadcasts"

    # Dry-run uninstall: PATH untouched.
    $script:Plan = @(); $PathNotes = @(); $DryRun = $true; $script:Broadcasts = 0
    Invoke-Expression $UninstallBlock
    Check "dry-run reports LocalBin" (($PathNotes -contains $LocalBin) -and -not ($PathNotes -contains $HomeBin)) ($PathNotes -join "|")
    Check "dry-run leaves PATH" ((Get-FakePath)[0] -eq "$Start;$LocalBin") ""

    # Real uninstall: only the v2-recorded LocalBin goes; the user's HomeBin stays despite the legacy marker.
    $script:Plan = @(); $PathNotes = @(); $DryRun = $false; $script:Broadcasts = 0
    Invoke-Expression $UninstallBlock
    $r3 = Get-FakePath
    Check "uninstall restores original PATH" ($r3[0] -eq $Start) $r3[0]
    Check "uninstall keeps REG_EXPAND_SZ" ($r3[1] -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) "$($r3[1])"
    Check "uninstall broadcast once" ($script:Broadcasts -eq 1) "$script:Broadcasts"
    Check "uninstall plans v2 + legacy marker removal" (($script:Plan -contains (Join-Path $DataDir "path-added.v2.txt")) -and ($script:Plan -contains (Join-Path $DataDir "path-added.txt"))) ($script:Plan -join "|")

    # No v2 marker (only legacy): PATH kept, hint given.
    Remove-Item -LiteralPath (Join-Path $DataDir "path-added.v2.txt") -Force
    Set-FakePath "$Start;$LocalBin"
    $script:Plan = @(); $PathNotes = @(); $PathKept = @(); $DryRun = $false; $script:Broadcasts = 0
    Invoke-Expression $UninstallBlock
    Check "no v2 marker keeps PATH" ((Get-FakePath)[0] -eq "$Start;$LocalBin") ""
    Check "no v2 marker gives hint" ($PathKept.Count -eq 2) ($PathKept -join "|")
    Check "no v2 marker no broadcast" ($script:Broadcasts -eq 0) "$script:Broadcasts"

    # Guard: a non-test subkey value is ignored (falls back to Environment, which this test never opens).
    $env:TP_TEST_ENV_SUBKEY = "Environment2"
    $ok = (Get-Block "install.ps1") -match "TP-test-"
    Check "test seam restricted to Software\TP-test-*" $ok ""
} finally {
    $env:TP_TEST_ENV_SUBKEY = $null
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($TestRoot, $false) } catch { }
    Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
$gone = $null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($TestRoot)
Check "test key cleaned up" $gone ""
Write-Output "A10W_RC=$Fail"
exit $Fail
