# Project Cam launcher
# Starts a local HTTP server and opens the main menu in your default browser.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$port = 8000
$url  = "http://localhost:$port"

function Start-Server {
    param([string]$cmd, [string[]]$cmdArgs)
    Write-Host "Starting server: $cmd $($cmdArgs -join ' ')"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName  = $cmd
    $psi.Arguments = ($cmdArgs -join ' ')
    $psi.WorkingDirectory = $PSScriptRoot
    $psi.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}

$python = Get-Command python -ErrorAction SilentlyContinue
$py     = Get-Command py -ErrorAction SilentlyContinue
$node   = Get-Command node -ErrorAction SilentlyContinue

if ($python) {
    Start-Server 'python' @('-m','http.server', $port)
} elseif ($py) {
    Start-Server 'py' @('-3','-m','http.server', $port)
} elseif ($node) {
    Start-Server 'npx' @('--yes','serve', '.', '-l', $port)
} else {
    Write-Host "Could not find python or node on your PATH." -ForegroundColor Red
    Write-Host "Install Python (https://python.org) or Node.js (https://nodejs.org) and try again."
    Pause
    exit 1
}

Start-Sleep -Milliseconds 1200
Write-Host "Opening $url ..."
Start-Process $url
Write-Host ""
Write-Host "Project Cam is running at $url"
Write-Host "Press Ctrl+C in the server window to stop."
