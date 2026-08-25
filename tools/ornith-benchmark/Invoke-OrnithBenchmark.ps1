[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('Preflight', 'DryRun', 'PlanLive', 'RunShortSweep', 'RunFinalCampaign')]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Config,

    [switch]$HashFiles
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$nodeVersion = & $nodeCommand.Source --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
    throw "Node.js 24.x is required; found '$nodeVersion'."
}

$resolvedConfig = (Resolve-Path -LiteralPath $Config).Path
$cli = Join-Path $PSScriptRoot 'bin\ornith-benchmark.mjs'
$subcommand = switch ($Command) {
    'DryRun' { 'dry-run' }
    'PlanLive' { 'plan-live' }
    'RunShortSweep' { 'run-short-sweep' }
    'RunFinalCampaign' { 'run-final-campaign' }
    default { 'preflight' }
}
$arguments = @($cli, $subcommand, '--config', $resolvedConfig)
if ($Command -in @('RunShortSweep', 'RunFinalCampaign')) {
    $arguments += '--confirm-live'
}
if ($HashFiles) {
    $arguments += '--hash-files'
}

& $nodeCommand.Source @arguments
exit $LASTEXITCODE
