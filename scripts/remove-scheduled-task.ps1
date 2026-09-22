param(
    [string]$TaskName = 'DeltaHarvestAdvisor'
)

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Scheduled task removed: $TaskName"
} else {
    Write-Output "Scheduled task not found: $TaskName"
}
