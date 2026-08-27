#!/usr/bin/env pwsh
<#
  Runs backend (Go, :8000) and frontend (SvelteKit, :5173) together for local dev.
  Each runs in its own window so logs stay separate and either can be closed/Ctrl+C'd
  independently.
#>

param(
	[switch]$SameWindow  # run both in this window instead, output interleaved
)

$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

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
