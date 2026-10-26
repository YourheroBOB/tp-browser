# Uninstall TP on Windows.
# Removes what install.ps1 created: copied trees under ~/.local/share/ego-linux and
# ~/ego-linux-install, .cmd / shell wrappers, the User PATH entries for those bin
# directories, the Startup launcher, and the agent skill copies.
# profile-agent, token, and logs stay unless --purge.
# Stopping always goes through scripts/ego-stop.ps1, which stops only this instance.
# Usage: uninstall.ps1 [--dry-run] [--purge]
$ErrorActionPreference = "Stop"

$DryRun = $false
$Purge = $false
$Help = $false
foreach ($a in $args) {
    $k = "$a".ToLowerInvariant()
    if ($k -eq "--dry-run" -or $k -eq "-dry-run" -or $k -eq "-dryrun") { $DryRun = $true }
    elseif ($k -eq "--purge" -or $k -eq "-purge") { $Purge = $true }
    elseif ($k -eq "--help" -or $k -eq "-h" -or $k -eq "-help") { $Help = $true }
    else {
        Write-Output "Unknown option: $a"
        exit 2
    }
}
if ($Help) {
    Write-Output "Usage: uninstall.ps1 [--dry-run] [--purge]"
    Write-Output "Remove the TP install. User data (profile-agent, token, logs) is kept unless --purge."
    Write-Output "--dry-run prints the paths that would be removed and does not delete them."
    exit 0
}

if (-not $HOME -or $HOME -eq "\" -or $HOME -eq "/") {
    Write-Output "Refusing to uninstall: HOME is empty or a filesystem root."
    exit 3
}

$DataDir = Join-Path $HOME ".local\share\ego-linux"
$InstallDir = Join-Path $HOME "ego-linux-install"
$LocalBin = Join-Path $HOME ".local\bin"
$HomeBin = Join-Path $HOME "bin"
$Plan = @()

function Add-Plan([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = (Get-Item -LiteralPath $Path -Force).FullName
    if ($script:Plan -notcontains $full) { $script:Plan += $full }
}

function Test-HasPlannedChild([string]$Dir) {
    $prefix = $Dir.TrimEnd('\', '/') 
    $prefix = $prefix + [IO.Path]::DirectorySeparatorChar
    foreach ($p in $script:Plan) {
        if ($p.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $p.Length -gt $prefix.Length) {
            return $true
        }
    }
    return $false
}

function Test-WouldBeEmpty([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return $false }
    $items = @(Get-ChildItem -Force -LiteralPath $Dir -ErrorAction SilentlyContinue)
    foreach ($it in $items) {
        if ($script:Plan -notcontains $it.FullName) { return $false }
    }
    return $true
}

function Add-EmptyParents([string[]]$Dirs) {
    foreach ($dir in $Dirs) {
        if ((Test-HasPlannedChild $dir) -and (Test-WouldBeEmpty $dir)) { Add-Plan $dir }
    }
}

$Copied = @("bin", "daemon", "lib", "scripts", "tools", "tests", "skills")
foreach ($root in @($DataDir, $InstallDir)) {
    foreach ($name in $Copied) {
        Add-Plan (Join-Path $root $name)
    }
}
if ((Test-HasPlannedChild $InstallDir) -and (Test-WouldBeEmpty $InstallDir)) { Add-Plan $InstallDir }

$WrapperNames = @(
    "ego-browser.cmd", "tp-browser.cmd", "ego-browser", "tp-browser",
    "ego-start.cmd", "tp-start.cmd", "ego-headed.cmd", "tp-headed.cmd",
    "ego-stop.cmd", "tp-stop.cmd"
)
foreach ($dir in @($LocalBin, $HomeBin)) {
    foreach ($name in $WrapperNames) {
        $path = Join-Path $dir $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $text = ""
        try { $text = Get-Content -LiteralPath $path -Raw -ErrorAction Stop } catch { $text = "" }
        if ($text -match "ego-linux") { Add-Plan $path }
    }
}

$SkillRoots = @(
    (Join-Path $HOME ".claude\skills"),
    (Join-Path $HOME ".agents\skills"),
    (Join-Path $HOME ".codex\skills")
)
foreach ($base in $SkillRoots) {
    foreach ($name in @("tp-browser", "ego-browser")) {
        $dir = Join-Path $base $name
        $skill = Join-Path $dir "SKILL.md"
        if (-not (Test-Path -LiteralPath $skill)) { continue }
        $known = @("api.md", "platforms.md", "troubleshooting.md")
        $refDir = Join-Path $dir "references"
        $refOurs = $true
        if (Test-Path -LiteralPath $refDir) {
            $refExtra = @(Get-ChildItem -Force -LiteralPath $refDir -ErrorAction SilentlyContinue | Where-Object { $known -notcontains $_.Name })
            if ($refExtra.Count -gt 0) { $refOurs = $false }
        }
        $others = @(Get-ChildItem -Force -LiteralPath $dir -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "SKILL.md" -and -not ($_.Name -eq "references" -and $refOurs) })
        if ($others.Count -eq 0) { Add-Plan $dir } else {
            Add-Plan $skill
            foreach ($r in $known) { $rp = Join-Path $refDir $r; if (Test-Path -LiteralPath $rp) { Add-Plan $rp } }
        }
    }
}
Add-EmptyParents @(
    (Join-Path $HOME ".claude\skills"), (Join-Path $HOME ".claude"),
    (Join-Path $HOME ".agents\skills"), (Join-Path $HOME ".agents"),
    (Join-Path $HOME ".codex\skills"), (Join-Path $HOME ".codex")
)

$Startup = ""
try { $Startup = [Environment]::GetFolderPath("Startup") } catch { $Startup = "" }
if ($Startup) {
    $Vbs = Join-Path $Startup "tp-browser-autostart.vbs"
    if (Test-Path -LiteralPath $Vbs) {
        $vtext = ""
        try { $vtext = Get-Content -LiteralPath $Vbs -Raw -ErrorAction Stop } catch { $vtext = "" }
        if ($vtext -match "ego-linux|ego-start\.ps1") { Add-Plan $Vbs }
    }
}

if ($Purge -and (Test-Path -LiteralPath $DataDir)) {
    Get-ChildItem -Force -LiteralPath $DataDir -ErrorAction SilentlyContinue | ForEach-Object { Add-Plan $_.FullName }
    Add-Plan $DataDir
}

$Stop = Join-Path $DataDir "scripts\ego-stop.ps1"
if (-not (Test-Path -LiteralPath $Stop)) {
    $Stop = Join-Path $PSScriptRoot "scripts\ego-stop.ps1"
}
if (Test-Path -LiteralPath $Stop) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    if ($DryRun) {
        $env:TP_DRY_RUN = "1"
        & $Stop
    } else {
        Remove-Item Env:\TP_DRY_RUN -ErrorAction SilentlyContinue
        & $Stop
    }
    $ErrorActionPreference = $prev
} else {
    Write-Output "scripts/ego-stop.ps1 not found; skipped stop"
}

$PathNotes = @()
# RG-A10b: only remove PATH entries install.ps1 recorded in path-added.txt, only when that bin dir will hold
# nothing but TP wrappers, and keep the raw REG_EXPAND_SZ value so other entries stay unexpanded.
$Marker = Join-Path $DataDir "path-added.txt"
$OursAdded = @()
if (Test-Path -LiteralPath $Marker) { $OursAdded = @(Get-Content -LiteralPath $Marker | Where-Object { $_ -ne "" } | ForEach-Object { $_.TrimEnd('\') }) }
function Test-BinEmptyAfterPlan([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { return $true }
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
        if (-not ($Plan -contains $f.FullName)) { return $false }
    }
    return $true
}
$EnvKey = $null
try { $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true) } catch { $EnvKey = $null }
if ($EnvKey -and $OursAdded.Count -gt 0) {
    $UserPath = [string]$EnvKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $PathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    try { $PathKind = $EnvKey.GetValueKind("Path") } catch { }
    $keep = @()
    foreach ($part in ($UserPath -split ";" | Where-Object { $_ -ne "" })) {
        $trim = $part.TrimEnd('\')
        $isOurs = ($OursAdded -icontains $trim) -and (($trim -ieq $LocalBin.TrimEnd('\')) -or ($trim -ieq $HomeBin.TrimEnd('\'))) -and (Test-BinEmptyAfterPlan $trim)
        if ($isOurs) { $PathNotes += $part } else { $keep += $part }
    }
    if ($PathNotes.Count -gt 0 -and -not $DryRun) {
        $EnvKey.SetValue("Path", ($keep -join ";"), $PathKind)
    }
}
if ($EnvKey) { $EnvKey.Close() }
if ($PathNotes.Count -gt 0 -and (Test-Path -LiteralPath $Marker)) { Add-Plan $Marker }

if ($DryRun) {
    foreach ($p in $Plan) { Write-Output "would remove: $p" }
    foreach ($p in $PathNotes) { Write-Output "would remove PATH: $p" }
    if ($Plan.Count -eq 0 -and $PathNotes.Count -eq 0) { Write-Output "would remove: (nothing)" }
    Write-Output "dry-run: no files removed"
    exit 0
}

foreach ($p in $Plan) {
    if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Write-Output "TP uninstall finished"
if ($Purge) {
    Write-Output "User data purged."
} else {
    Write-Output "Kept user data (profile-agent, token, logs). Use --purge to delete them."
}
if ($PathNotes.Count -gt 0) {
    Write-Output ("Removed User PATH entries: " + ($PathNotes -join "; "))
}
exit 0
