# Register agent-bridge into local MCP clients (codex / claude).
# Usage:
#   .\register.ps1            register
#   .\register.ps1 -Remove    unregister
# NOTE: kept ASCII-only on purpose - Windows PowerShell 5.1 reads .ps1 as ANSI
#       and UTF-8 Chinese text without BOM breaks the parser.
param([switch]$Remove)

$ErrorActionPreference = "Continue"
$server = Join-Path $PSScriptRoot "agent-bridge.mjs"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) { Write-Host "node not found in PATH" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $server)) { Write-Host "missing: $server" -ForegroundColor Red; exit 1 }

Write-Host "node   : $node"
Write-Host "server : $server"
Write-Host ("-" * 64)

foreach ($cli in @("codex", "claude")) {
  $exe = Get-Command $cli -ErrorAction SilentlyContinue
  if (-not $exe) { Write-Host "[$cli] not installed, skip" -ForegroundColor DarkGray; continue }

  # drop any existing entry first (claude may have a project-scope one)
  & $cli mcp remove agent-bridge 2>&1 | Out-Null
  if ($cli -eq "claude") { & $cli mcp remove --scope user agent-bridge 2>&1 | Out-Null }

  if ($Remove) {
    Write-Host "[$cli] removed" -ForegroundColor Yellow
    continue
  }

  if ($cli -eq "claude") {
    & $cli mcp add --scope user agent-bridge -- $node $server 2>&1 | ForEach-Object { "  $_" }
  } else {
    & $cli mcp add agent-bridge -- $node $server 2>&1 | ForEach-Object { "  $_" }
  }

  if ($LASTEXITCODE -eq 0) {
    Write-Host "[$cli] registered" -ForegroundColor Green
  } else {
    Write-Host "[$cli] failed (exit $LASTEXITCODE)" -ForegroundColor Red
  }
}

Write-Host ("-" * 64)
Write-Host "verify : codex mcp list / claude mcp list"
Write-Host "restart the client, then list_agents + ask_agent appear in the tool list"
