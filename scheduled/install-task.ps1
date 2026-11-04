# Registers (or replaces) the Windows scheduled task that runs sp2redmine every day at 22:00 local time.
# This PC's time zone must be Cairo (Egypt Standard Time) for that to be 10 PM Cairo.
param([string]$At = '22:00')

$runner = Join-Path $PSScriptRoot 'run-daily.ps1' | Resolve-Path
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# StartWhenAvailable: if the PC was off/asleep at 22:00, run as soon as it's back.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'sp2redmine daily' -Description 'Log Super Productivity time to Redmine' `
  -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Get-ScheduledTask -TaskName 'sp2redmine daily' | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime
