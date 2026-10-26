# RG-A7: scoped process control for one TP instance on Windows (dot-sourced by ego-start/ego-stop).
# Stops only: PIDs recorded at launch, the pid reported by the daemon on $Port IF it serves our data
# dir, and browser processes started with exactly our --user-data-dir. Never matches by bare name.
function Get-TpScopedPids([string]$DataDir, [string]$ProfileDir, [int]$Port) {
    $ids = New-Object System.Collections.Generic.List[int]
    $pf = Join-Path $DataDir "tp-pids-$Port"
    if (Test-Path $pf) { foreach ($l in Get-Content $pf) { if ($l -match '^[a-z]+=(\d+)$') { $ids.Add([int]$Matches[1]) } } }
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
        if ($h.pid -and $h.dataDir -and (($h.dataDir.TrimEnd('\','/') -replace '/', '\') -ieq $DataDir.TrimEnd('\'))) { $ids.Add([int]$h.pid) }
    } catch {}
    $flag = "--user-data-dir=$ProfileDir"
    $all = @(Get-CimInstance Win32_Process)
    foreach ($p in $all) {
        $c = [string]$p.CommandLine
        if ($c -and ($c.Contains("$flag`"") -or $c.Contains("$flag ") -or $c.EndsWith($flag))) { $ids.Add([int]$p.ProcessId) }
    }
    $out = @()
    foreach ($id in ($ids | Sort-Object -Unique)) {
        if ($id -eq $PID) { continue }
        $p = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
        if (-not $p) { continue }
        $c = [string]$p.CommandLine
        if ($c -like "*ego-browserd.js*" -or $c -like "*tp-browserd.js*" -or $c.Contains($flag)) { $out += $id }
    }
    return ,$out
}
function Stop-TpScoped([string]$DataDir, [string]$ProfileDir, [int]$Port) {
    $v = Get-TpScopedPids $DataDir $ProfileDir $Port
    if ($env:TP_DRY_RUN) { Write-Output ("TP_DRY_RUN would stop: " + ($v -join ' ')); return 0 }
    foreach ($id in $v) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Remove-Item -Force (Join-Path $DataDir "tp-pids-$Port") -ErrorAction SilentlyContinue
    return $v.Count
}
function Invoke-TpFlushClose([string]$DataDir, [int]$Port) {
    # RG-A6: /flush-and-close requires the daemon token
    $tf = Join-Path $DataDir "token"
    if (-not (Test-Path $tf)) { return }
    try {
        $tok = (Get-Content -Raw $tf).Trim()
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/flush-and-close" -Headers @{ "x-tp-token" = $tok } -TimeoutSec 3 | Out-Null
    } catch {}
}
