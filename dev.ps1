#!/usr/bin/env pwsh
<#
  Runs Temporal (dev server), the Zigflow-worker-managing backend (Go, :8000), and the
  frontend (SvelteKit, :5173) together for local dev. Installs the Temporal CLI and the
  zigflow CLI on first run if either is missing.

  Temporal always gets its own window (it's infra, not app code, and its logs are noisy).
  Backend/frontend run in their own windows by default, or as interleaved background jobs
  in this window with -SameWindow.
#>

param(
	[switch]$SameWindow  # run backend/frontend in this window instead, output interleaved
)

$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$toolsDir = Join-Path $backend '.tools'
$temporalExe = Join-Path $toolsDir 'temporal.exe'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
	Write-Error "go not found on PATH. Install Go: https://go.dev/dl/"
	exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
	Write-Error "pnpm not found on PATH. Install: npm install -g pnpm"
	exit 1
}
if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
	Write-Host "Installing frontend dependencies (pnpm install)..." -ForegroundColor Yellow
	Push-Location $frontend
	pnpm install
	Pop-Location
}

function Test-PortOpen([int]$Port) {
	try {
		$client = New-Object System.Net.Sockets.TcpClient
		$task = $client.ConnectAsync('127.0.0.1', $Port)
		$ok = $task.Wait(300) -and $client.Connected
		$client.Close()
		return $ok
	}
	catch {
		return $false
	}
}

function Install-ZigflowIfMissing {
	if (Get-Command zigflow -ErrorAction SilentlyContinue) { return }

	Write-Host "zigflow CLI not found — installing (go install github.com/zigflow/zigflow@latest)..." -ForegroundColor Yellow
	go install github.com/zigflow/zigflow@latest

	$gobin = (go env GOPATH)
	$binDir = Join-Path $gobin 'bin'
	if (-not (Get-Command zigflow -ErrorAction SilentlyContinue)) {
		Write-Warning "zigflow installed to $binDir, which isn't on PATH. Add it to PATH, or the backend won't be able to start workflow execution workers."
	}
}

function Install-TemporalCliIfMissing {
	if (Test-Path $temporalExe) { return }

	New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
	Write-Host "Temporal CLI not found — downloading latest release..." -ForegroundColor Yellow

	try {
		$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/temporalio/cli/releases/latest'
	}
	catch {
		Write-Warning "Couldn't reach GitHub to fetch the Temporal CLI release ($_). Install manually: https://github.com/temporalio/cli/releases (extract temporal.exe into $toolsDir)"
		return
	}

	$arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
	$asset = $release.assets | Where-Object { $_.name -match "windows.*$arch.*\.zip$" } | Select-Object -First 1
	if (-not $asset) {
		Write-Warning "No Windows $arch asset found in the latest temporalio/cli release. Install manually: https://github.com/temporalio/cli/releases (extract temporal.exe into $toolsDir)"
		return
	}

	$zipPath = Join-Path $toolsDir 'temporal-cli.zip'
	Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
	Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
	Remove-Item $zipPath

	if (-not (Test-Path $temporalExe)) {
		Write-Warning "Extracted the Temporal CLI release but temporal.exe wasn't found directly in $toolsDir — check the archive layout."
	}
}

function Start-TemporalDevServer {
	if (Test-PortOpen 7233) {
		Write-Host "Temporal already running on :7233" -ForegroundColor DarkGray
		return
	}

	$exe = if (Test-Path $temporalExe) { $temporalExe } else { (Get-Command temporal -ErrorAction SilentlyContinue).Source }
	if (-not $exe) {
		Write-Warning "No Temporal CLI available — skipping dev server startup. Workflow executions will fail (502) until Temporal is running on :7233."
		return
	}

	Start-Process pwsh -ArgumentList @(
		'-NoExit', '-Command',
		"Write-Host 'Temporal dev server — grpc localhost:7233, web UI http://localhost:8233' -ForegroundColor Cyan; & '$exe' server start-dev"
	)

	Write-Host "Waiting for Temporal to come up..." -ForegroundColor Yellow
	$deadline = (Get-Date).AddSeconds(20)
	while (-not (Test-PortOpen 7233) -and (Get-Date) -lt $deadline) {
		Start-Sleep -Milliseconds 500
	}
	if (Test-PortOpen 7233) {
		Write-Host "Temporal is up (web UI: http://localhost:8233)" -ForegroundColor Cyan
	}
	else {
		Write-Warning "Temporal didn't come up within 20s — check its window for errors."
	}
}

Install-ZigflowIfMissing
Install-TemporalCliIfMissing
Start-TemporalDevServer

if ($SameWindow) {
	$backendJob = Start-Job -Name 'duraflow-backend' -ScriptBlock {
		Set-Location $using:backend
		go run ./cmd/server
	}
	$frontendJob = Start-Job -Name 'duraflow-frontend' -ScriptBlock {
		Set-Location $using:frontend
		pnpm dev
	}

	Write-Host "Backend:  http://localhost:8000 (docs at /docs)" -ForegroundColor Cyan
	Write-Host "Frontend: http://localhost:5173" -ForegroundColor Cyan
	Write-Host "Ctrl+C to stop both.`n" -ForegroundColor Cyan

	try {
		while ($true) {
			Receive-Job $backendJob -ErrorAction SilentlyContinue | ForEach-Object { "[backend]  $_" }
			Receive-Job $frontendJob -ErrorAction SilentlyContinue | ForEach-Object { "[frontend] $_" }
			if ($backendJob.State -ne 'Running' -or $frontendJob.State -ne 'Running') {
				break
			}
			Start-Sleep -Milliseconds 300
		}
	}
	finally {
		Stop-Job $backendJob, $frontendJob -ErrorAction SilentlyContinue
		Remove-Job $backendJob, $frontendJob -Force -ErrorAction SilentlyContinue
	}
}
else {
	Start-Process pwsh -ArgumentList @(
		'-NoExit', '-Command',
		"Set-Location '$backend'; Write-Host 'duraflow backend — http://localhost:8000 (docs at /docs)' -ForegroundColor Cyan; go run ./cmd/server"
	)
	Start-Process pwsh -ArgumentList @(
		'-NoExit', '-Command',
		"Set-Location '$frontend'; Write-Host 'duraflow frontend — http://localhost:5173' -ForegroundColor Cyan; pnpm dev"
	)
	Write-Host "Backend and frontend launched in separate windows." -ForegroundColor Cyan
	Write-Host "Backend:  http://localhost:8000 (docs at /docs)"
	Write-Host "Frontend: http://localhost:5173"
}
