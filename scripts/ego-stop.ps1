$ErrorActionPreference = "SilentlyContinue"
$Stopped = 0
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -match '^(node|chrome|msedge|brave)\.exe$') -and
    ($_.CommandLine -like "*ego-browserd.js*" -or $_.CommandLine -like "*ego-linux*profile-agent*")
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $Stopped++
}
Write-Output "EGO_STOPPED (terminated $Stopped processes)"
