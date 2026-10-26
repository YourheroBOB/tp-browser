# Isolated Windows end-to-end run (RG-G11): throwaway USERPROFILE + private ports, real ego-start/ego-stop.
# Never touches the user's main TP instance (9772/9773) or any other browser. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\isolated\run-windows.ps1 [-DaemonPort 9810] [-ChromePort 9811]
param([int]$DaemonPort = 9810, [int]$ChromePort = 9811, [int]$FixturePort = 8899)
$env:TP_FIXTURE_PORT = "$FixturePort"
Set-Location $env:TEMP  # cmd.exe child processes fail when the caller cwd is a UNC/WSL path
$ErrorActionPreference = "Continue"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$T = Join-Path $env:TEMP ("tp-iso-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$IsoHome = Join-Path $T "home"
$DataDir = Join-Path $IsoHome ".local\share\ego-linux"
$ProfileDir = Join-Path $DataDir "profile-agent"
$RC = 0
function Ok($n, $c, $x = "") { if ($c) { Write-Output "PASS $n $x" } else { Write-Output "FAIL $n $x"; $script:RC = 1 } }
function PortBusy($p) { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect("127.0.0.1", $p); $true } catch { $false } finally { $c.Close() } }
foreach ($p in $DaemonPort, $ChromePort, $FixturePort) { if (PortBusy $p) { Write-Output "PORT_BUSY $p"; exit 3 } }
$MainUpBefore = $false; try { $null = Invoke-RestMethod "http://127.0.0.1:9772/health" -TimeoutSec 2; $MainUpBefore = $true } catch {}
$OtherBrowserBefore = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge)\.exe$' }).Count

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
foreach ($d in "bin", "daemon", "lib", "scripts", "tools", "tests", "skills") { Copy-Item -Recurse -Force (Join-Path $Repo $d) (Join-Path $DataDir $d) }
$RealProfile = $env:USERPROFILE
$env:USERPROFILE = $IsoHome; $env:EGO_BROWSERD_PORT = "$DaemonPort"; $env:EGO_CHROME_PORT = "$ChromePort"
$Srv = Start-Process -FilePath node -ArgumentList "`"$Repo\tests\serve.mjs`"" -WindowStyle Hidden -PassThru
# decoy: name-matching killers would hit it (mentions ego-browserd.js and a similar profile path)
$Decoy = Start-Process -FilePath node -ArgumentList "-e", "setTimeout(()=>{},600000)", "ego-browserd.js", "`"--user-data-dir=$ProfileDir-decoy`"" -WindowStyle Hidden -PassThru
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DataDir "scripts\ego-start.ps1") 2>&1 | Out-String
  Ok "G11 ego-start isolated" ($out -match "EGO_READY \(port=$DaemonPort, chrome=$ChromePort") ("{0}ms {1}" -f $sw.ElapsedMilliseconds, $out.Trim())
  $h = $null; try { $h = Invoke-RestMethod "http://127.0.0.1:$DaemonPort/health" -TimeoutSec 2 } catch {}
  Ok "G11 daemon uses isolated data dir" ($h -and $h.dataDir -ieq $DataDir) ([string]$h.dataDir)
  $pf = Join-Path $DataDir "tp-pids-$DaemonPort"
  Ok "A7 pid file written" (Test-Path $pf) ((Get-Content $pf -ErrorAction SilentlyContinue) -join ",")
  foreach ($s in @(Get-Item (Join-Path $Repo "tests\smoke.ego.js")) + @(Get-ChildItem (Join-Path $Repo "tests\isolated\*.ego.js"))) {
    Write-Output "=== $($s.Name)"
    $o = cmd /d /c "node `"$DataDir\bin\ego-browser.js`" nodejs < `"$($s.FullName)`"" 2>&1 | Out-String
    Write-Output $o.TrimEnd()
    if ($LASTEXITCODE -ne 0 -or $o -match '(?m)^FAIL') { $RC = 1 }
  }
  # resource snapshot of this instance only
  $mine = @(Get-CimInstance Win32_Process | Where-Object { ([string]$_.CommandLine).Contains("--user-data-dir=$ProfileDir`"") -or ([string]$_.CommandLine).Contains("--user-data-dir=$ProfileDir ") -or ($h -and $_.ProcessId -eq $h.pid) })
  $ws = 0; foreach ($p in $mine) { $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($gp) { $ws += $gp.WorkingSet64 } }
  Write-Output ("INFO G11 instance processes={0} workingSetMB={1:N0}" -f $mine.Count, ($ws / 1MB))
  $kind = (cmd /d /c "node --experimental-websocket `"$Repo\tests\isolated\cdp-cookie.mjs`" $ChromePort tp_a2_sess" 2>&1 | Out-String).Trim()
  Ok "A2 fixture cookie stays session" ($kind -eq "session") $kind
  $env:TP_DRY_RUN = "1"
  $dry = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DataDir "scripts\ego-stop.ps1") 2>&1 | Out-String
  Remove-Item Env:TP_DRY_RUN
  Ok "A7 dry-run targets our daemon" ($h -and $dry -match "\b$($h.pid)\b") $dry.Trim()
  Ok "A7 dry-run does not target decoy" ($dry -notmatch "\b$($Decoy.Id)\b")
  $stop = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DataDir "scripts\ego-stop.ps1") 2>&1 | Out-String
  Start-Sleep -Seconds 2
  Ok "A7 ego-stop ran" ($stop -match "EGO_STOPPED") $stop.Trim()
  Ok "A7 isolated daemon stopped" (-not (PortBusy $DaemonPort))
  Ok "A7 isolated browser stopped" (-not (PortBusy $ChromePort))
  Ok "A7 decoy survived" ([bool](Get-Process -Id $Decoy.Id -ErrorAction SilentlyContinue))
  $left = @(Get-CimInstance Win32_Process | Where-Object { ([string]$_.CommandLine).Contains("--user-data-dir=$ProfileDir`"") })
  Ok "A7 no leftover browser processes for our profile" ($left.Count -eq 0) $left.Count
  $vf = @(Get-ChildItem $DataDir -Include cookies-vault.json, storage-vault.json, session-tabs.json -Recurse -ErrorAction SilentlyContinue).Count
  Ok "A2 default: no vault files written" ($vf -eq 0) $vf
  if ($MainUpBefore) { $up = $false; try { $null = Invoke-RestMethod "http://127.0.0.1:9772/health" -TimeoutSec 2; $up = $true } catch {}; Ok "A7 main TP 9772 still healthy" $up }
  $OtherAfter = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge)\.exe$' -and -not ([string]$_.CommandLine).Contains($T) }).Count
  Write-Output "INFO other chrome/edge processes before=$OtherBrowserBefore after=$OtherAfter"
} finally {
  $env:USERPROFILE = $RealProfile
  foreach ($p in $Srv, $Decoy) { if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
  foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { ([string]$_.CommandLine).Contains($T) })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
}
Write-Output "WIN_ISO_RC=$RC"
exit $RC
