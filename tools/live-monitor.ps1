<#
.SYNOPSIS
  State-change recorder for a live OpenCodex + Codex + local-model session.

.DESCRIPTION
  Polls every -IntervalSeconds and prints ONE line per state CHANGE, timestamped. It is
  deliberately not a tail of everything: the questions being answered are "did it start", "did it
  load", "did it release", and those are edges, not levels.

  Watched state:
    - codex.exe / ChatGPT.exe          -> is Codex actually running (codex.exe is the real anchor)
    - opencodex /healthz               -> proxy up, pid, uptime
    - llama-server.exe                 -> local engine resident, and how much RAM it holds
    - /api/local-runtime/status        -> supervisor state, context window, compaction point
    - /api/logs                        -> every request the proxy served: model, provider, status

  The /api/logs feed makes auto-review, auto-compaction, and sub-agent turns visible. Helper
  provenance is persisted in usage.jsonl, so a completed run can be audited after Codex closes;
  this recorder additionally captures the desktop/model lifecycle edges in one human-readable log.

  Read-only. Issues no POST/PUT and changes no configuration.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\live-monitor.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\live-monitor.ps1 -IntervalSeconds 1 -LogPath run.txt
#>
[CmdletBinding()]
param(
  [int]$Port = 10100,
  [double]$IntervalSeconds = 2,
  [string]$LogPath
)

$ErrorActionPreference = "Continue"
$base = "http://127.0.0.1:$Port"
$qwenCompactLimits = @{
  "131072" = 112066
  "184320" = 157593
}

function Write-Event {
  param([string]$Category, [string]$Message, [string]$Color = "Gray")
  $line = "{0}  {1,-10} {2}" -f (Get-Date -Format "HH:mm:ss"), $Category, $Message
  Write-Host $line -ForegroundColor $Color
  if ($LogPath) { Add-Content -Path $LogPath -Value $line -Encoding utf8 }
}

function Get-Json {
  param([string]$Path)
  try {
    return Invoke-RestMethod -Uri "$base$Path" -TimeoutSec 4 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-ProcInfo {
  param([string]$Name)
  $p = Get-Process -Name $Name -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  $ws = 0
  foreach ($one in $p) { $ws += $one.WorkingSet64 }
  return [pscustomobject]@{
    Count = @($p).Count
    Pids  = (@($p) | ForEach-Object { $_.Id }) -join ","
    WsGB  = [math]::Round($ws / 1GB, 2)
  }
}

Write-Host ""
Write-Host "OpenCodex live monitor - watching $base" -ForegroundColor Cyan
Write-Host "Change-only output. Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# Previous observation. $null means "not yet sampled", so the first loop prints a baseline
# instead of pretending everything just changed.
$prev = @{
  Codex   = $null
  Chat    = $null
  Proxy   = $null
  Llama   = $null
  Runtime = $null
}
$seenLogIds = New-Object 'System.Collections.Generic.HashSet[string]'
$firstPass = $true

while ($true) {
  # --- Codex desktop app -------------------------------------------------------------------
  $codex = Get-ProcInfo -Name "codex"
  $codexNow = if ($codex) { "running pid=$($codex.Pids)" } else { "absent" }
  if ($codexNow -ne $prev.Codex) {
    if ($firstPass) { Write-Event "codex" "baseline: $codexNow" "DarkGray" }
    elseif ($codex) { Write-Event "codex" "STARTED  ($($codex.Pids))" "Green" }
    else            { Write-Event "codex" "CLOSED - expect the model to release ~20s from now" "Yellow" }
    $prev.Codex = $codexNow
  }

  $chat = Get-ProcInfo -Name "ChatGPT"
  $chatNow = if ($chat) { "running x$($chat.Count)" } else { "absent" }
  if ($chatNow -ne $prev.Chat) {
    if (-not $firstPass) { Write-Event "chatgpt" $chatNow "DarkGray" }
    $prev.Chat = $chatNow
  }

  # --- proxy -------------------------------------------------------------------------------
  $health = Get-Json "/healthz"
  if ($health) {
    $proxyNow = "up pid=$($health.pid) v$($health.version)"
  } else {
    $proxyNow = "down"
  }
  if ($proxyNow -ne $prev.Proxy) {
    if ($firstPass)      { Write-Event "proxy" "baseline: $proxyNow" "DarkGray" }
    elseif ($health)     { Write-Event "proxy" "UP       $proxyNow" "Green" }
    else                 { Write-Event "proxy" "DOWN" "Red" }
    $prev.Proxy = $proxyNow
  }

  # --- local engine ------------------------------------------------------------------------
  $llama = Get-ProcInfo -Name "llama-server"
  if ($llama) { $llamaNow = "resident $($llama.WsGB) GB pid=$($llama.Pids)" } else { $llamaNow = "not resident" }
  if ($llamaNow -ne $prev.Llama) {
    if ($firstPass)   { Write-Event "model" "baseline: $llamaNow" "DarkGray" }
    elseif ($llama)   { Write-Event "model" "LOADED   $llamaNow" "Green" }
    else              { Write-Event "model" "RELEASED - RAM returned" "Yellow" }
    $prev.Llama = $llamaNow
  }

  # --- supervisor view (state + the context window that drives compaction) -----------------
  $rt = Get-Json "/api/local-runtime/status"
  if ($rt) {
    $nctx = $rt.effective.nCtx
    if (-not $nctx) { $nctx = $rt.requested.nCtx }
    if ($nctx) {
      # Qwen's two catalog thresholds are fixed policy. Other preserved profiles use the
      # canonical 0.855 fallback.
      $compactAt = $qwenCompactLimits["$nctx"]
      if (-not $compactAt) { $compactAt = [math]::Floor($nctx * 0.855) }
      $rtNow = "$($rt.state) ctx=$nctx compacts=$compactAt"
    } else {
      $rtNow = "$($rt.state) ctx=?"
    }
    if ($rtNow -ne $prev.Runtime) {
      if ($firstPass) { Write-Event "runtime" "baseline: $rtNow" "DarkGray" }
      else            { Write-Event "runtime" $rtNow "Cyan" }
      $prev.Runtime = $rtNow
    }
  }

  # --- request feed: this is where auto-review and sub-agent turns become visible -----------
  $logs = Get-Json "/api/logs?limit=40"
  if ($logs) {
    $rows = $logs
    if ($logs.PSObject.Properties.Name -contains "logs") { $rows = $logs.logs }
    elseif ($logs.PSObject.Properties.Name -contains "entries") { $rows = $logs.entries }
    foreach ($row in @($rows)) {
      if (-not $row) { continue }
      $id = "$($row.requestId)"
      if (-not $id) { $id = "$($row.timestamp)|$($row.model)|$($row.status)" }
      if ($seenLogIds.Contains($id)) { continue }
      [void]$seenLogIds.Add($id)
      # On the first pass just absorb history; only NEW requests should be announced.
      if ($firstPass) { continue }
      $model = "$($row.model)"
      $provider = "$($row.provider)"
      $status = "$($row.status)"
      $colour = "White"
      $tag = "request"
      $helper = "$($row.helperTurn)"
      $source = "$($row.helperSourceModel)"
      $effort = "$($row.helperReasoningEffort)"
      if ($helper -eq "auto-review")     { $tag = "REVIEW"; $colour = "Magenta" }
      elseif ($helper -eq "auto-compact") { $tag = "COMPACT"; $colour = "Cyan" }
      elseif ($model -like "*qwen*")     { $colour = "Green" }
      if ($status -and [int]::TryParse($status, [ref]([int]0)) -and [int]$status -ge 400) { $colour = "Red" }
      $helperDetail = ""
      if ($helper) { $helperDetail = "  helper=$helper source=$source effort=$effort" }
      Write-Event $tag "$model  via $provider  -> $status$helperDetail" $colour
    }
    if ($seenLogIds.Count -gt 4000) { $seenLogIds.Clear() }
  }

  if ($firstPass) {
    Write-Host ""
    Write-Host "  baseline captured - now reporting changes only" -ForegroundColor DarkGray
    Write-Host ""
    $firstPass = $false
  }

  Start-Sleep -Seconds $IntervalSeconds
}
