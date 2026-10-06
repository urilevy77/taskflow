# install-schedule.ps1 — registers autopilot/daily.mjs as a Windows Task
# Scheduler job, per design/autopilot-plan.md's "Scheduling" section.
#
# Cloud /schedule agents can't do this job: they can't reach data/, this
# machine's Chrome profile, or the WhatsApp session (see plan). Task
# Scheduler is the right tool because it survives sleep/wake and needs no
# live session — the same reasoning docs/AUTOMATION.md gives for the plain
# `scan.mjs` cron/launchd/Task-Scheduler recipes this mirrors on Windows.
#
# What this registers is deliberately NARROW: stages 1-5, 8-9 only (scan,
# lane-route, triage — all budgeted/bounded). Stage 6 (full evaluation) does
# not exist in daily.mjs yet (decided 2026-09-25 — see daily.mjs's header),
# so nothing this task runs can incur evaluation-scale cost; the daily
# ceiling is --budget-triage's own cap.
#
# Usage (run from an elevated or normal PowerShell — Task Scheduler itself
# needs no admin rights for a per-user task):
#   .\autopilot\install-schedule.ps1                        # register, 17:30 daily, budget 60
#   .\autopilot\install-schedule.ps1 -Time "08:00" -BudgetTriage 60
#   .\autopilot\install-schedule.ps1 -Uninstall              # remove the task
#   .\autopilot\install-schedule.ps1 -DryRun                 # print what would be registered, register nothing

param(
    [string]$Time = "17:30",
    [int]$BudgetTriage = 60,
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$TaskName = "career-ops autopilot daily"
$RepoRoot = Split-Path -Parent $PSScriptRoot   # this script lives in autopilot/, repo root is its parent
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
$LogDir = Join-Path $RepoRoot "data\runs"
$LogFile = Join-Path $LogDir "task-scheduler.log"

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task '$TaskName'."
    } else {
        Write-Output "No scheduled task named '$TaskName' found — nothing to remove."
    }
    exit 0
}

if (-not $NodePath) {
    Write-Error "node.exe not found on PATH. Install Node 22+ and ensure it's on PATH before scheduling."
    exit 1
}

if (-not (Test-Path (Join-Path $RepoRoot "autopilot\daily.mjs"))) {
    Write-Error "autopilot\daily.mjs not found under $RepoRoot — run this script from the checkout, not a copy."
    exit 1
}

$ScriptPath = Join-Path $RepoRoot "autopilot\daily.mjs"
$Arguments = "`"$ScriptPath`" --budget-triage $BudgetTriage"

Write-Output "Task name:      $TaskName"
Write-Output "Node:           $NodePath"
Write-Output "Script:         $ScriptPath"
Write-Output "Arguments:      $Arguments"
Write-Output "Working dir:    $RepoRoot"
Write-Output "Trigger:        daily at $Time"
Write-Output "Output logged:  $LogFile (redirected by the task; daily.mjs also writes data/runs/{date}.json + the runs table)"

if ($DryRun) {
    Write-Output "`n[DryRun] Nothing registered."
    exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# cmd /c wraps the node invocation so stdout/stderr redirection works the
# same way it would from an interactive shell — Task Scheduler's own action
# model has no native "redirect to file" option.
$WrappedCommand = "cmd.exe"
$WrappedArgs = "/c `"`"$NodePath`" $Arguments >> `"$LogFile`" 2>&1`""

$Action = New-ScheduledTaskAction -Execute $WrappedCommand -Argument $WrappedArgs -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
# StartWhenAvailable: a missed run (machine asleep at trigger time) fires as
# soon as the machine wakes, instead of being silently skipped until
# tomorrow — same behavior docs/AUTOMATION.md's launchd recipe relies on.
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "`nTask '$TaskName' already exists — replacing its definition."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "career-ops autopilot: scan + lane-route + triage (design/autopilot-plan.md). No evaluation stage — see daily.mjs header." `
    | Out-Null

Write-Output "`nRegistered. Verify any time with:"
Write-Output "  Get-ScheduledTask -TaskName `"$TaskName`" | Get-ScheduledTaskInfo"
Write-Output "Run it once right now (real cost — triages up to $BudgetTriage rows) with:"
Write-Output "  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Output "Remove it with:"
Write-Output "  .\autopilot\install-schedule.ps1 -Uninstall"
