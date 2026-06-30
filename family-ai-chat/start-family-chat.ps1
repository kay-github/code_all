$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$envPath = Join-Path $root ".env"
if (-not (Test-Path $envPath)) {
  throw "Missing .env file. Copy env.template to .env and fill in your values."
}

$envText = Get-Content $envPath -Raw
$missing = @()
if ($envText -match "REPLACE_WITH_YOUR_OPENAI_API_KEY") { $missing += "OPENAI_API_KEY" }
if ($envText -match "REPLACE_WITH_YOUR_CLOUDFLARE_TUNNEL_TOKEN") { $missing += "CLOUDFLARE_TUNNEL_TOKEN" }
if ($envText -match "FamilyChat-Change-Me-2026") { $missing += "CHAT_ACCESS_CODE" }

if ($missing.Count -gt 0) {
  Write-Host "Please edit .env first. Missing or unchanged values:" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host " - $_" -ForegroundColor Yellow }
  exit 1
}

docker compose pull
docker compose up -d

Start-Process "http://localhost:3000"
docker compose ps
