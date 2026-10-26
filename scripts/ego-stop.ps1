# RG-A7: stop only this TP instance (recorded PIDs / our daemon / our --user-data-dir), never by bare name.
$ErrorActionPreference = "SilentlyContinue"
# same base dir node os.homedir() uses on Windows, so an isolated USERPROFILE isolates both
$HomeBase = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DataDir = Join-Path $HomeBase ".local\share\ego-linux"
$ProfileDir = Join-Path $DataDir "profile-agent"
. (Join-Path $PSScriptRoot "tp-proc.ps1")
$Ports = if ($env:EGO_BROWSERD_PORT) { @([int]$env:EGO_BROWSERD_PORT) } else { @(9772, 9774) }
$Stopped = 0
if (-not $env:TP_DRY_RUN) { foreach ($p in $Ports) { Invoke-TpFlushClose $DataDir $p }; Start-Sleep -Milliseconds 1000 }
foreach ($p in $Ports) { $r = Stop-TpScoped $DataDir $ProfileDir $p; if ($r -is [int]) { $Stopped += $r } else { $r } }
if (-not $env:TP_DRY_RUN) { Write-Output "EGO_STOPPED (terminated $Stopped processes)" }
