#Requires -Version 7
<#
.SYNOPSIS
  Consolidate the DeepSeek Harness autostart into one logon task, idempotently and reversibly.

.DESCRIPTION
  The desktop application used to start from several overlapping tasks. This script
  records the full definition of every legacy task, removes them, and registers one
  task that starts the application hidden. Every step is idempotent: running the
  script again changes nothing when the target state already holds.

  Use -Rollback to restore the recorded legacy definitions.

.PARAMETER DryRun
  Report the planned actions without touching the Task Scheduler.

.PARAMETER Rollback
  Restore the legacy tasks recorded by a previous run and remove the consolidated one.

.PARAMETER StatePath
  Where the recorded legacy definitions are stored. Defaults to
  "$env:USERPROFILE\.dsh\state\autostart-migration.json".

.EXAMPLE
  pwsh -File apply-autostart.ps1 -DryRun
#>
param(
    [switch]$DryRun,
    [switch]$Rollback,
    [string]$StatePath = (Join-Path $env:USERPROFILE '.dsh\state\autostart-migration.json'),
    [string[]]$LegacyTaskNames = @('DSH Autostart (logon +30s)', 'DSH start to tray', 'DSH start-hidden patch'),
    [string]$TaskName = 'DSH Autostart',
    [string]$Executable = 'C:\Users\Ruslan\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$message) {
    Write-Output ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $message)
}

function Read-State {
    if (-not (Test-Path $StatePath)) { return $null }
    return Get-Content $StatePath -Raw | ConvertFrom-Json
}

function Save-State($state) {
    $dir = Split-Path -Parent $StatePath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $state | ConvertTo-Json -Depth 8
    Set-Content -Path $StatePath -Value $json -Encoding utf8
}

function Get-LegacyDefinitions {
    $definitions = @()
    foreach ($name in $LegacyTaskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($null -eq $task) { continue }
        $definitions += [pscustomobject]@{ name = $name; xml = (Export-ScheduledTask -TaskName $name) }
    }
    return $definitions
}

if ($Rollback) {
    $state = Read-State
    if ($null -eq $state) { Write-Step 'rollback: no recorded definitions'; exit 1 }
    foreach ($entry in $state.legacyTasks) {
        if ($DryRun) { Write-Step ('dry-run: would restore ' + $entry.name); continue }
        Register-ScheduledTask -TaskName $entry.name -Xml $entry.xml -Force | Out-Null
        Write-Step ('restored ' + $entry.name)
    }
    if (-not $DryRun) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Step ('removed ' + $TaskName)
    }
    exit 0
}

$legacy = @(Get-LegacyDefinitions)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($legacy.Count -eq 0 -and $null -ne $existing) {
    Write-Step 'already consolidated: nothing to do'
    exit 0
}

if ($DryRun) {
    foreach ($entry in $legacy) { Write-Step ('dry-run: would record and remove ' + $entry.name) }
    Write-Step ('dry-run: would register ' + $TaskName + ' -> ' + $Executable)
    exit 0
}

if ($legacy.Count -gt 0) {
    Save-State ([pscustomobject]@{
        version      = 1
        appliedAt    = (Get-Date).ToUniversalTime().ToString('o')
        legacyTasks  = $legacy
        installedTask = $TaskName
    })
    foreach ($entry in $legacy) {
        Unregister-ScheduledTask -TaskName $entry.name -Confirm:$false
        Write-Step ('removed legacy task ' + $entry.name)
    }
}

if (-not (Test-Path $Executable)) {
    Write-Step ('error: executable not found: ' + $Executable)
    exit 1
}

function New-AutostartTaskXml {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $escaped = [System.Security.SecurityElement]::Escape($Executable)
    $workdir = [System.Security.SecurityElement]::Escape((Split-Path -Parent $Executable))
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts DeepSeek Harness hidden in the tray once per logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
      <UserId>$sid</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"$escaped"</Command>
      <Arguments>--start-hidden</Arguments>
      <WorkingDirectory>$workdir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

# Registering a logon trigger with the object cmdlets is denied for the current
# user on this host; the XML form registers the same task without elevation and
# keeps the rollback path identical. A failed registration restores the legacy
# tasks so the machine never loses its autostart.
try {
    $xml = New-AutostartTaskXml
    Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
} catch {
    Write-Step ('error: could not register ' + $TaskName + ': ' + $_.Exception.Message)
    $state = Read-State
    if ($null -ne $state) {
        foreach ($entry in $state.legacyTasks) {
            Register-ScheduledTask -TaskName $entry.name -Xml $entry.xml -Force | Out-Null
            Write-Step ('restored after failure ' + $entry.name)
        }
    }
    exit 1
}
Write-Step ('registered ' + $TaskName)

$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
Write-Step ('running instances: ' + $running.Count)
exit 0
