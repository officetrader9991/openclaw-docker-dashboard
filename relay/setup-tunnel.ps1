#Requires -RunAsAdministrator
<#
  Set up a permanent Cloudflare Named Tunnel for the OpenClaw Relay.
  Run this script once after you have a Cloudflare-managed domain.

  Prerequisites:
    - cloudflared installed (winget install Cloudflare.cloudflared)
    - A domain added to your free Cloudflare account (https://dash.cloudflare.com)
    - Nameservers pointed to Cloudflare and propagated

  This script will:
    1. Authenticate with Cloudflare (opens browser)
    2. Create a named tunnel called "openclaw-relay"
    3. Route a subdomain (relay.<yourdomain>) to the tunnel
    4. Write config.yml
    5. Install cloudflared as a Windows Service
#>

$ErrorActionPreference = "Stop"

# ─── Find cloudflared ────────────────────────────────────────

$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (!$cf) {
  $cf = Get-Item "C:\Program Files (x86)\cloudflared\cloudflared.exe" -ErrorAction SilentlyContinue
}
if (!$cf) {
  Write-Error "cloudflared not found. Install with: winget install Cloudflare.cloudflared"
  exit 1
}
$cloudflared = if ($cf.Source) { $cf.Source } else { $cf.FullName }
Write-Host "Using cloudflared at: $cloudflared" -ForegroundColor Gray

$ConfigDir = Join-Path $env:USERPROFILE ".cloudflared"

# ─── Step 1: Login ───────────────────────────────────────────

$certPath = Join-Path $ConfigDir "cert.pem"
if (Test-Path $certPath) {
  Write-Host "Already authenticated (cert.pem exists). Skipping login." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "STEP 1: Authenticate with Cloudflare" -ForegroundColor Cyan
  Write-Host "A browser window will open. Log in and authorize the tunnel." -ForegroundColor Yellow
  Write-Host ""
  & $cloudflared tunnel login
  if (!(Test-Path $certPath)) {
    Write-Error "Login failed — cert.pem not found at $ConfigDir"
    exit 1
  }
  Write-Host "Login successful." -ForegroundColor Green
}

# ─── Step 2: Create tunnel ──────────────────────────────────

$TunnelName = "openclaw-relay"

$existingTunnels = & $cloudflared tunnel list --output json 2>$null | ConvertFrom-Json
$existing = $existingTunnels | Where-Object { $_.name -eq $TunnelName }

if ($existing) {
  $TunnelId = $existing.id
  Write-Host "Tunnel '$TunnelName' already exists (ID: $TunnelId). Skipping creation." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "STEP 2: Creating tunnel '$TunnelName'..." -ForegroundColor Cyan
  & $cloudflared tunnel create $TunnelName
  
  $existingTunnels = & $cloudflared tunnel list --output json 2>$null | ConvertFrom-Json
  $existing = $existingTunnels | Where-Object { $_.name -eq $TunnelName }
  if (!$existing) {
    Write-Error "Failed to create tunnel."
    exit 1
  }
  $TunnelId = $existing.id
  Write-Host "Tunnel created with ID: $TunnelId" -ForegroundColor Green
}

# ─── Step 3: Route DNS ──────────────────────────────────────

Write-Host ""
$domain = Read-Host "Enter your Cloudflare-managed domain (e.g., mydomain.com)"
$subdomain = "relay.$domain"

Write-Host "STEP 3: Routing $subdomain -> tunnel '$TunnelName'..." -ForegroundColor Cyan
& $cloudflared tunnel route dns $TunnelName $subdomain 2>&1
Write-Host "DNS route created: $subdomain" -ForegroundColor Green

# ─── Step 4: Write config.yml ──────────────────────────────

$credsFile = Join-Path $ConfigDir "$TunnelId.json"
if (!(Test-Path $credsFile)) {
  Write-Warning "Credentials file not found at $credsFile — check $ConfigDir manually."
}

$configPath = Join-Path $ConfigDir "config.yml"
$configContent = @"
tunnel: $TunnelId
credentials-file: $credsFile

ingress:
  - hostname: $subdomain
    service: http://localhost:3400
  - service: http_status:404
"@

Set-Content -Path $configPath -Value $configContent -Encoding UTF8
Write-Host ""
Write-Host "STEP 4: Config written to $configPath" -ForegroundColor Green
Write-Host $configContent -ForegroundColor Gray

# ─── Step 5: Install as Windows Service ─────────────────────

Write-Host ""
Write-Host "STEP 5: Installing cloudflared as a Windows Service..." -ForegroundColor Cyan

$svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Cloudflared service already installed. Restarting..." -ForegroundColor Yellow
  & $cloudflared service uninstall 2>$null
  Start-Sleep -Seconds 2
}

& $cloudflared service install
Start-Sleep -Seconds 3

$svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "Cloudflared service is running." -ForegroundColor Green
} else {
  Write-Host "Starting Cloudflared service..." -ForegroundColor Yellow
  Start-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq "Running") {
    Write-Host "Cloudflared service is running." -ForegroundColor Green
  } else {
    Write-Warning "Cloudflared service may not have started. Check with: Get-Service Cloudflared"
  }
}

# ─── Summary ────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " SETUP COMPLETE" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host " Tunnel Name:   $TunnelName"
Write-Host " Tunnel ID:     $TunnelId"
Write-Host " Public URL:    https://$subdomain"
Write-Host " Config:        $configPath"
Write-Host " Credentials:   $credsFile"
Write-Host ""
Write-Host " Next steps:" -ForegroundColor Yellow
Write-Host "   1. Update RELAY_URL on Zeabur to: https://$subdomain"
Write-Host "   2. Test: curl https://$subdomain/api/health"
Write-Host ""
Write-Host " The tunnel will auto-start on boot and survive restarts."
Write-Host ""

$subdomain | Set-Content (Join-Path $PSScriptRoot ".tunnel-domain") -Encoding UTF8
