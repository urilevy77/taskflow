# install-phone-server.ps1 — starts autopilot/phone-server.mjs at logon, so the phone page is up
# whenever you are logged in (design/daily-task-design.md §13).
#
# Prerequisites (the server refuses to start without them):
#   - AUTOPILOT_PHONE_TOKEN in .env (16+ random characters)
#   - AUTOPILOT_PHONE_HOST in .env = this PC's Tailscale IP (`tailscale ip -4`), so only your own
#     tailnet devices can connect. Left unset it listens on 127.0.0.1 (this PC only).
#
# Usage:
#   .\autopilot\install-phone-server.ps1 -DryRun     # show what would be registered
#   .\autopilot\install-phone-server.ps1             # register (per-user, no admin needed)
#   .\autopilot\install-phone-server.ps1 -Uninstall

param(
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$TaskName = "career-ops phone page"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
$ScriptPath = Join-Path $RepoRoot "autopilot\phone-server.mjs"
$LogFile = Join-Path $RepoRoot "data\runs\phone-server.log"

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task '$TaskName'."
    } else {
        Write-Output "No scheduled task named '$TaskName' - nothing to remove."
    }
    exit 0
}

if (-not $NodePath) { Write-Error "node.exe not found on PATH."; exit 1 }
if (-not (Test-Path $ScriptPath)) { Write-Error "$ScriptPath not found - run this from the checkout."; exit 1 }

$envFile = Join-Path $RepoRoot ".env"
$envText = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { "" }
if ($envText -notmatch '(?m)^\s*AUTOPILOT_PHONE_TOKEN=\S{16,}') {
    Write-Warning "AUTOPILOT_PHONE_TOKEN is not set (16+ chars) in .env - the server will refuse to start until it is."
}
if ($envText -notmatch '(?m)^\s*AUTOPILOT_PHONE_HOST=\S+') {
    Write-Warning "AUTOPILOT_PHONE_HOST is not set - the server will listen on 127.0.0.1 only (this PC, not the phone)."
}

Write-Output "Task name:   $TaskName"
Write-Output "Runs:        `"$NodePath`" `"$ScriptPath`""
Write-Output "Trigger:     at logon of $env:USERNAME"
Write-Output "Log:         $LogFile"

if ($DryRun) {
    Write-Output "`n[DryRun] Nothing registered."
    exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
# Hidden window: a visible console gets closed by accident, and closing it kills the server (Ctrl+C exit).
$Inner = "& '$NodePath' '$ScriptPath' *>> '$LogFile'"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$Inner`"" -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Restart on failure; no time limit - it is meant to run for the whole session.
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "career-ops autopilot phone page (token-protected; records 'I applied' / 'Skip'; never submits)." | Out-Null

Write-Output "`nRegistered. Start it now without logging out:  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Output "Link for the phone:  node autopilot\phone-server.mjs --print-link"
Write-Output "Remove with:         .\autopilot\install-phone-server.ps1 -Uninstall"
