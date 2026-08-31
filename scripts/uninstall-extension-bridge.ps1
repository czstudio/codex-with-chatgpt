[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "C2C Local Extension Bridge"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Output "uninstalled $taskName"
