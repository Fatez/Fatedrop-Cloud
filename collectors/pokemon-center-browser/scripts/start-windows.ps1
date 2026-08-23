[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$ProfilePath = (Join-Path $env:LOCALAPPDATA "FateDrop\PokemonCenterChrome"),
  [string]$StartUrl = "https://www.pokemoncenter.com/en-gb/search/tcg-cards",
  [int]$ChromeReadySeconds = 30
)

$ErrorActionPreference = "Stop"
$collectorRoot = Split-Path -Parent $PSScriptRoot
$probeUrl = "http://127.0.0.1:$Port/json/version"

function Test-ChromeCdp {
  try {
    $response = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch {
    return $false
  }
}

function Find-ChromeExecutable {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe" }),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  ) | Where-Object { $_ -and (Test-Path $_) }

  if (-not $candidates) {
    throw "Google Chrome was not found in the standard Windows install locations. Install Chrome or start a Chrome CDP session manually on port $Port."
  }
  return $candidates[0]
}

Set-Location $collectorRoot

if (-not (Test-Path (Join-Path $collectorRoot ".env"))) {
  throw "Missing collectors/pokemon-center-browser/.env. Copy .env.example to .env and set the Signal Engine ingest URL and secret before starting the host."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm was not found on PATH. Install Node.js 20+ before starting the Pokémon Center collector host."
}

if (-not (Test-ChromeCdp)) {
  $chrome = Find-ChromeExecutable
  New-Item -ItemType Directory -Force -Path $ProfilePath | Out-Null

  Write-Host "Starting dedicated FateDrop Chrome profile on CDP port $Port..."
  $arguments = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$ProfilePath`"",
    "--no-first-run",
    $StartUrl
  )
  Start-Process -FilePath $chrome -ArgumentList $arguments | Out-Null

  $deadline = (Get-Date).AddSeconds([Math]::Max(5, $ChromeReadySeconds))
  while ((Get-Date) -lt $deadline -and -not (Test-ChromeCdp)) {
    Start-Sleep -Seconds 1
  }
}

if (-not (Test-ChromeCdp)) {
  throw "Chrome did not expose its normal CDP endpoint at $probeUrl. FateDrop will not start the collector without a real browser session."
}

Write-Host "Chrome CDP is ready. Starting the FateDrop collector supervisor..."
& npm start
exit $LASTEXITCODE
