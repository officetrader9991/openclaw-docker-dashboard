#Requires -RunAsAdministrator
<#
  Install the OpenClaw Relay as a Windows Service using NSSM.
  Run this script once, from an elevated (Administrator) PowerShell prompt.

  Prerequisites:
    - Node.js installed and on PATH
    - NSSM installed (winget install nssm OR download from https://nssm.cc)
    - relay/node_modules installed (npm install in relay/)
#>

$ErrorActionPreference = "Stop"

# ─── Configuration ──────────────────────────────────────────

$ServiceName  = "OpenClawRelay"
$RelayDir     = Split-Path -Parent $PSScriptRoot  # one level up = relay/
$RelayDir     = Join-Path $RelayDir "relay"
if (!(Test-Path (Join-Path $RelayDir "server.mjs"))) {
  $RelayDir = $PSScriptRoot
}
$ServerScript = Join-Path $RelayDir "server.mjs"
$NodeExe      = (Get-Command node -ErrorAction Stop).Source
$RelayApiKey  = "openclaw-fleet-relay-2024"
$LogDir       = Join-Path $RelayDir "logs"

# ─── Preflight checks ──────────────────────────────────────

if (!(Test-Path $ServerScript)) {
  Write-Error "Cannot find $ServerScript — run this script from the relay/ directory."
  exit 1
}

$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (!$nssm) {
  Write-Host "NSSM not found. Installing via winget..." -ForegroundColor Yellow
  winget install nssm --accept-package-agreements --accept-source-agreements
  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if (!$nssm) {
    Write-Error "NSSM installation failed. Download manually from https://nssm.cc"
    exit 1
  }
}

# ─── Remove existing service if present ─────────────────────

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping and removing existing '$ServiceName' service..." -ForegroundColor Yellow
  nssm stop $ServiceName 2>$null
  nssm remove $ServiceName confirm
  Start-Sleep -Seconds 2
}

# ─── Create log directory ───────────────────────────────────

if (!(Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ─── Install the service ───────────────────────────────────

Write-Host "Installing '$ServiceName' service..." -ForegroundColor Cyan

nssm install $ServiceName $NodeExe $ServerScript
nssm set $ServiceName AppDirectory $RelayDir
nssm set $ServiceName DisplayName "OpenClaw Fleet Relay"
nssm set $ServiceName Description "HTTP relay for OpenClaw Docker fleet management"
nssm set $ServiceName Start SERVICE_AUTO_START

# Environment variables
nssm set $ServiceName AppEnvironmentExtra "RELAY_API_KEY=$RelayApiKey" "RELAY_PORT=3400"

# Logging — rotate at 10 MB
$StdoutLog = Join-Path $LogDir "relay-stdout.log"
$StderrLog = Join-Path $LogDir "relay-stderr.log"
nssm set $ServiceName AppStdout $StdoutLog
nssm set $ServiceName AppStderr $StderrLog
nssm set $ServiceName AppStdoutCreationDisposition 4
nssm set $ServiceName AppStderrCreationDisposition 4
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 10485760

# Restart policy: restart after 5 s on failure, up to 3 retries in 60 s
nssm set $ServiceName AppRestartDelay 5000
nssm set $ServiceName AppThrottle 60000

# ─── Start the service ─────────────────────────────────────

Write-Host "Starting '$ServiceName'..." -ForegroundColor Cyan
nssm start $ServiceName

Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq "Running") {
  Write-Host ""
  Write-Host "SUCCESS: '$ServiceName' is running." -ForegroundColor Green
  Write-Host "  Logs:    $LogDir" -ForegroundColor Gray
  Write-Host "  Port:    3400" -ForegroundColor Gray
  Write-Host ""
  Write-Host "Useful commands:" -ForegroundColor Yellow
  Write-Host "  nssm status $ServiceName       # check status"
  Write-Host "  nssm restart $ServiceName      # restart"
  Write-Host "  nssm stop $ServiceName         # stop"
  Write-Host "  nssm edit $ServiceName         # open GUI editor"
  Write-Host "  nssm remove $ServiceName confirm  # uninstall"
} else {
  Write-Warning "'$ServiceName' did not start. Check logs at $LogDir"
  nssm status $ServiceName
}
