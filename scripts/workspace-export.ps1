#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Export all data for a workspace to a JSON bundle.
  Usage: ./scripts/workspace-export.ps1 -WorkspaceId default -OutputDir backups
#>
param(
  [string]$WorkspaceId = "default",
  [string]$OutputDir   = "backups",
  [string]$ApiToken    = $env:OPS_API_TOKEN
)

$ErrorActionPreference = "Stop"
$ROOT    = Split-Path $PSScriptRoot -Parent
$API     = "http://localhost:3001"

if (-not $ApiToken) {
  # Try loading from .env
  $ApiToken = (Get-Content "$ROOT\.env" | Select-String "OPS_API_TOKEN=") -replace 'OPS_API_TOKEN=','' -replace '"',''
}
if (-not $ApiToken) { throw "OPS_API_TOKEN not set. Pass -ApiToken or set in .env" }

$headers = @{ Authorization = "Bearer $ApiToken"; "Content-Type" = "application/json" }

Write-Host "Exporting workspace: $WorkspaceId" -ForegroundColor Cyan

# Collect all workspace data
$bundle = @{
  exportedAt  = (Get-Date -Format "o")
  workspaceId = $WorkspaceId
  version     = "1.0"
  data        = @{}
}

$endpoints = @{
  workflows     = "/api/v1/workflows?limit=500"
  workflow_runs = "/api/v1/workflow-runs?limit=500"
  memories      = "/api/v1/memory?limit=500"
  briefings     = "/api/v1/briefings?limit=500"
  events        = "/api/v1/events?limit=500"
  dead_letter   = "/api/v1/dead-letter?limit=500"
  risks         = "/api/v1/risks?limit=500"
  opportunities = "/api/v1/opportunities?limit=500"
  businesses    = "/api/v1/businesses?limit=500"
}

foreach ($key in $endpoints.Keys) {
  try {
    $resp = Invoke-RestMethod -Uri "$API$($endpoints[$key])" -Headers $headers -ErrorAction Stop
    $bundle.data[$key] = $resp.data
    $count = if ($resp.data -is [array]) { $resp.data.Count } else { 1 }
    Write-Host "  ${key}: $count items" -ForegroundColor DarkCyan
  } catch {
    Write-Host "  ${key}: FAILED -- $($_.Exception.Message)" -ForegroundColor Yellow
    $bundle.data[$key] = @()
  }
}

# Save
$outPath = "$ROOT\$OutputDir"
if (-not (Test-Path $outPath)) { New-Item -ItemType Directory -Path $outPath -Force | Out-Null }
$ts   = Get-Date -Format "yyyyMMdd-HHmmss"
$file = "$outPath\workspace-$WorkspaceId-$ts.json"

$bundle | ConvertTo-Json -Depth 20 | Out-File $file -Encoding utf8

$size = (Get-Item $file).Length
$sizeKb = [math]::Round($size / 1024, 1)
Write-Host "Export saved: $file ($sizeKb KB)" -ForegroundColor Green
Write-Output $file
