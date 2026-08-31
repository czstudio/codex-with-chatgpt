[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $WorkspaceRoot
)

$ErrorActionPreference = "Stop"
$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$workspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
  throw "workspace root does not exist: $WorkspaceRoot"
}
if ($workspace.Contains('"')) {
  throw "workspace path contains an unsupported quote"
}

$packageRoot = Split-Path -Parent $scriptRoot
$cliPath = Join-Path $packageRoot "dist\cli\index.js"
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "built CLI not found: $cliPath (run pnpm build first)"
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$taskName = "C2C Local Extension Bridge"
$arguments = '"{0}" extension start --workspace "{1}" --port 0' -f $cliPath, $workspace
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $workspace
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType InteractiveToken -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Write-Output "installed $taskName for $workspace"
