[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'
$previousToken = $env:MOYSKLAD_TOKEN
$previousPort = $env:HTTP_PORT
Push-Location $PSScriptRoot

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js and npm, then reopen your terminal.'
    }

    if ($Reinstall -or -not (Test-Path 'node_modules/typescript/bin/tsc')) {
        Write-Host 'Installing dependencies...'
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }

    Write-Host 'Building the server...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }

    if ([string]::IsNullOrWhiteSpace($env:MOYSKLAD_TOKEN)) {
        $moyskladSecret = Read-Host 'MoySklad token (hidden)' -AsSecureString
        try {
            $env:MOYSKLAD_TOKEN = [System.Net.NetworkCredential]::new('', $moyskladSecret).Password
        }
        finally {
            $moyskladSecret.Dispose()
            Remove-Variable moyskladSecret
        }
    }
    if ([string]::IsNullOrWhiteSpace($env:MOYSKLAD_TOKEN)) {
        throw 'A MoySklad token is required.'
    }

    $env:HTTP_PORT = [string]$Port
    Write-Host "MCP endpoint: http://127.0.0.1:$Port/mcp"
    Write-Host "Health check: http://127.0.0.1:$Port/health"
    Write-Host 'Keep this terminal open. Press Ctrl+C to stop.'
    Write-Host "For ChatGPT, run in another terminal: ngrok http $Port"
    Write-Host 'The HTTP server has no incoming authentication. Protect access before using a business account.'
    & node dist/index.js
    if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE." }
}
finally {
    $env:MOYSKLAD_TOKEN = $previousToken
    $env:HTTP_PORT = $previousPort
    Pop-Location
}
