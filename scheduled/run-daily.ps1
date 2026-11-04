# Run by the "sp2redmine daily" scheduled task: logs yesterday + today without asking,
# guessing the activity for issues that have none yet. Re-runs are safe (entries are updated in place),
# so yesterday is included to pick up work done after the last run or a run missed while the PC was off.
$logDir = Join-Path $env:LOCALAPPDATA 'sp2redmine\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ((Get-Date -Format 'yyyy-MM-dd') + '.log')

$script = Join-Path $PSScriptRoot '..\sp2redmine.mjs'
$from = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')

"===== $(Get-Date -Format 's') =====" | Add-Content $log
& node $script --from $from -y --guess *>&1 | Add-Content $log
"exit code: $LASTEXITCODE`n" | Add-Content $log

# Keep 60 days of logs.
Get-ChildItem $logDir -Filter *.log | Where-Object LastWriteTime -lt (Get-Date).AddDays(-60) | Remove-Item
exit $LASTEXITCODE
