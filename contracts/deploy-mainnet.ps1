#!/usr/bin/env pwsh
# Deploy PACT to Robinhood Chain mainnet (4663).
#
#   ./deploy-mainnet.ps1                 # simulate only, nothing is broadcast
#   ./deploy-mainnet.ps1 -Broadcast      # deploy
#   ./deploy-mainnet.ps1 -Broadcast -Verify   # deploy, then verify both contracts and check the result
#
# Loads contracts/.env into this process, so no key is ever typed into a shell. Mainnet values use
# their own names (MAINNET_*), so no other deployment can inherit a mainnet wallet, or the reverse.
#
# The deployer key is PRIVATE_KEY. It is the one secret this script needs, and it must be funded
# first: the deploy is three transactions (registry, escrow, back-pointer) and all three are paid by
# that wallet.

param([switch]$Broadcast, [switch]$Verify)

# "Continue", not "Stop": PowerShell 5.1 turns a native command's stderr into an error record, and
# forge writes warnings there. With "Stop", a Cloudflare warning from the explorer would abort the
# script after a successful deploy. The verdict comes from the run's own output, below.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) { throw "contracts/.env not found" }

Get-Content ".env" | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $name, $value = $_ -split '=', 2
  $name = $name.Trim()
  $value = $value.Trim()
  if ($name -and $value) { Set-Item -Path "Env:$name" -Value $value }
}

# The script reads TREASURY / RESOLVER / PRIVATE_KEY; the file stores mainnet values under their own
# names so they cannot collide with any other deployment's wallets.
if ($env:MAINNET_TREASURY) { $env:TREASURY = $env:MAINNET_TREASURY }
if ($env:MAINNET_RESOLVER) { $env:RESOLVER = $env:MAINNET_RESOLVER }

if (-not $env:MAINNET_RPC_URL) { throw "MAINNET_RPC_URL is empty in .env" }
if (-not $env:TREASURY) { throw "MAINNET_TREASURY is empty in .env" }
if (-not $env:RESOLVER) { throw "MAINNET_RESOLVER is empty in .env" }
if (-not $env:PRIVATE_KEY) { throw "PRIVATE_KEY is empty in .env - the deployer key has to be there to sign" }

# Refuse to start against the wrong chain rather than trusting the URL to be what its name says.
$chainId = & cast chain-id --rpc-url $env:MAINNET_RPC_URL
if ($chainId.Trim() -ne "4663") { throw "MAINNET_RPC_URL answers chain $chainId, expected 4663" }

Write-Host "target:  $env:MAINNET_RPC_URL" -ForegroundColor DarkGray
Write-Host "treasury $env:TREASURY" -ForegroundColor DarkGray
Write-Host "resolver $env:RESOLVER" -ForegroundColor DarkGray
Write-Host "mode:    $(if ($Broadcast) { 'BROADCAST' } else { 'simulation' })" -ForegroundColor DarkGray

# The explorer's edge answers forge's user agent with a Cloudflare challenge, and forge verifies
# automatically after a broadcast. Point that call at the passthrough so it succeeds instead of
# filling the run with "Failed to deserialize response". See verify-proxy.mjs.
$proxy = Start-Process -FilePath "node" -ArgumentList "verify-proxy.mjs", "8555" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

$forgeArgs = @("script", "script/Deploy.s.sol", "--rpc-url", $env:MAINNET_RPC_URL,
  "--verifier", "blockscout", "--verifier-url", "http://127.0.0.1:8555/api")
if ($Broadcast) { $forgeArgs += "--broadcast" }

$log = Join-Path $env:TEMP "pact-deploy-mainnet.log"
Remove-Item $log -ErrorAction SilentlyContinue
try {
  # Written to a file as well as the console: forge's output arrives on both streams, and the
  # verdict below has to be read from what actually happened rather than from an exit code that a
  # failed verification can set after a successful deploy.
  & forge @forgeArgs 2>&1 | ForEach-Object {
    $_ | Out-File -FilePath $log -Append -Encoding utf8
    # The challenge page a blocked verification returns is one enormous line; the file keeps it, the
    # console does not need it.
    if ("$_".Length -lt 300) { Write-Host $_ }
  }
} finally {
  Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue
}

$output = Get-Content $log -Raw
$deployed = $output -match "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL"
$simulated = $output -match "SIMULATION COMPLETE"

if (-not $Broadcast) {
  if (-not $simulated) {
    Write-Host "the simulation did not complete - see $log" -ForegroundColor Red
    exit 1
  }
  Write-Host "simulation complete - nothing was broadcast. Add -Broadcast to deploy." -ForegroundColor Yellow
  exit 0
}

if (-not $deployed) {
  Write-Host "the broadcast did not report success - see $log" -ForegroundColor Red
  exit 1
}

# The addresses come from the broadcast record, which is the machine-readable truth of what landed.
$record = Get-ChildItem "broadcast/Deploy.s.sol/4663/run-latest.json" | Get-Content -Raw | ConvertFrom-Json
$names = ($record.transactions | Where-Object { $_.contractName -eq "PactNames" } | Select-Object -First 1).contractAddress
$escrow = ($record.transactions | Where-Object { $_.contractName -eq "PactEscrow" } | Select-Object -First 1).contractAddress

if (-not $names -or -not $escrow) { throw "no PactNames/PactEscrow address in the broadcast record" }

Write-Host ""
Write-Host "PactNames  $names" -ForegroundColor Green
Write-Host "PactEscrow $escrow" -ForegroundColor Green

$ctor = & cast abi-encode "c(address,address,address,address,uint64,uint64,uint64)" `
  "0x5173b8eA6923c2d40267890D45C46a3480954773" $env:TREASURY $env:RESOLVER $names 1209600 259200 2592000
Write-Host ""
Write-Host "constructor args (paste-level record):" -ForegroundColor DarkGray
Write-Host "  $ctor" -ForegroundColor DarkGray

if (-not $Verify) {
  Write-Host "deployed. Re-run with -Verify to publish the source, or start the passthrough and run:" -ForegroundColor Yellow
  Write-Host "  node verify-proxy.mjs 8555"
  Write-Host "  forge verify-contract $escrow src/PactEscrow.sol:PactEscrow --chain 4663 --verifier blockscout --verifier-url http://127.0.0.1:8555/api --constructor-args $ctor"
  Write-Host "  forge verify-contract $names src/PactNames.sol:PactNames --chain 4663 --verifier blockscout --verifier-url http://127.0.0.1:8555/api"
  exit 0
}

# The explorer's edge answers forge's user agent with a Cloudflare challenge, so the verification
# calls go through a local passthrough that sends an agent it accepts. See verify-proxy.mjs.
$proxy = Start-Process -FilePath "node" -ArgumentList "verify-proxy.mjs", "8555" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
try {
  foreach ($pair in @(@($escrow, "src/PactEscrow.sol:PactEscrow", $ctor), @($names, "src/PactNames.sol:PactNames", $null))) {
    $address, $target, $ctorArgs = $pair
    $verifyArgs = @("verify-contract", $address, $target, "--chain", "4663", "--verifier", "blockscout",
      "--verifier-url", "http://127.0.0.1:8555/api")
    if ($ctorArgs) { $verifyArgs += @("--constructor-args", $ctorArgs) }
    Write-Host "verifying $target ..." -ForegroundColor DarkGray
    & forge @verifyArgs 2>&1 | ForEach-Object { Write-Host $_ }
  }
} finally {
  Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue
}

# "Response: OK" only means the request was accepted - the explorer compiles afterwards. Ask it.
Write-Host ""
Write-Host "waiting for the explorer to publish ..." -ForegroundColor DarkGray
foreach ($address in @($escrow, $names)) {
  $verified = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    try {
      $response = Invoke-RestMethod -Uri "https://robinhoodchain.blockscout.com/api/v2/addresses/$address" -TimeoutSec 20
      if ($response.is_verified) { $verified = $true; break }
    } catch { }
  }
  if ($verified) { Write-Host "  $address is_verified = true" -ForegroundColor Green }
  else { Write-Host "  $address is_verified = false after 60s - check the source matches the deploy" -ForegroundColor Red }
}
