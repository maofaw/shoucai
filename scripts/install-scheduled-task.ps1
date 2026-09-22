param(
    [string]$TaskName = 'DeltaHarvestAdvisor'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $projectRoot 'src\cli.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute $node `
    -Argument "`"$entry`" run --notify" `
    -WorkingDirectory $projectRoot

$triggers = @(
    New-ScheduledTaskTrigger -Daily -At '06:50'
    New-ScheduledTaskTrigger -Daily -At '14:50'
    New-ScheduledTaskTrigger -Daily -At '22:50'
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At '21:20'
)

$principal = New-ScheduledTaskPrincipal `
    -UserId $identity `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Description 'Fetch moligod market data, update crafting advice, then exit.' `
    -Force | Out-Null

Write-Output "Scheduled task created: $TaskName"
Write-Output 'Run times: 06:50, 14:50, 22:50; Saturday 21:20'
