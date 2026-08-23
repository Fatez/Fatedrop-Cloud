[CmdletBinding()]
param(
  [string]$TaskName = "FateDrop Pokemon Center Collector",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "start-windows.ps1"
if (-not (Test-Path $launcher)) {
  throw "Collector launcher not found at $launcher"
}

$powerShellExe = (Get-Process -Id $PID).Path
$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""

$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 20 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Starts the normal Chrome-backed FateDrop Pokémon Center collector supervisor at user logon." `
  -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "It runs only in the signed-in user's interactive session so the collector continues to use a normal Chrome profile."

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started scheduled task."
}
