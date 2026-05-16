#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Import a workspace bundle (created by workspace-export.ps1).
  Only imports non-destructively — skips existing IDs.
  Usage: ./scripts/workspace-import.ps1 -BundleFile backups/workspace-default-*.json
#>
param(
  [Parameter(Mandatory)][string]$BundleFile,
  [string]$TargetWorkspaceId = "",
  [string]$ApiToken          = $env:OPS_API_TOKEN,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path $PSScriptRoot -Parent
$API  = "http://localhost:3001"

if (-not $ApiToken) {
  $ApiToken = (Get-Content "$ROOT\.env" | Select-String "OPS_API_TOKEN=") -replace 'OPS_API_TOKEN=','' -replace '"',''
}
if (-not $ApiToken) { throw "OPS_API_TOKEN not set" }
if (-not (Test-Path $BundleFile)) { throw "Bundle not found: $BundleFile" }

$bundle = Get-Content $BundleFile -Raw | ConvertFrom-Json
$srcWs  = $bundle.workspaceId
$dstWs  = if ($TargetWorkspaceId) { $TargetWorkspaceId } else { $srcWs }
$headers = @{ Authorization = "Bearer $ApiToken"; "Content-Type" = "application/json" }

Write-Host "Importing workspace bundle" -ForegroundColor Cyan
Write-Host "  Source workspace: $srcWs  →  Target: $dstWs"
Write-Host "  Exported at: $($bundle.exportedAt)"
if ($DryRun) { Write-Host "  DRY RUN — no writes" -ForegroundColor Yellow }

$results = @{ imported = 0; skipped = 0; failed = 0 }

# Import workflows only (memories/events/runs are derived/append-only)
$workflows = $bundle.data.workflows
Write-Host "`nImporting $($workflows.Count) workflow definitions..."
foreach ($wf in $workflows) {
  if ($DryRun) { Write-Host "  [DRY] Would import: $($wf.name)"; $results.imported++; continue }
  try {
    $body = @{
      name         = $wf.name
      description  = $wf.description
      steps        = $wf.steps
      triggers     = $wf.triggers
      retryPolicy  = $wf.retryPolicy
      timeout      = $wf.timeout
      tags         = $wf.tags
    } | ConvertTo-Json -Depth 10
    $resp = Invoke-RestMethod -Uri "$API/api/v1/workflows" -Method Post -Headers $headers -Body $body -ErrorAction Stop
    Write-Host "  ✓ $($wf.name) → $($resp.data.id)"
    $results.imported++
  } catch {
    $msg = $_.Exception.Message
    if ($msg -match "already exists|duplicate|conflict") {
      Write-Host "  ~ $($wf.name) — already exists, skipping"
      $results.skipped++
    } else {
      Write-Host "  ✗ $($wf.name) — $msg" -ForegroundColor Red
      $results.failed++
    }
  }
}

Write-Host "`nImport complete: $($results.imported) imported, $($results.skipped) skipped, $($results.failed) failed" -ForegroundColor Green
$results | ConvertTo-Json
