# KIT consumer policy; the installer/process/cleanup engine is shipped by @mpgd/cli.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$SourceMetadata,
    [Parameter(Mandatory = $true)][ValidateSet('x64', 'ARM64')][string]$Architecture,
    [string]$ModulePath,
    [ValidateSet('.github/workflows/ci.yml', '.github/workflows/published-starters.yml')]
    [string]$SourceWorkflow = '.github/workflows/ci.yml',
    [ValidatePattern('^[a-f0-9]{40}$')][string]$SourceGitSha = $env:GITHUB_SHA,
    [ValidateRange(10, 120)][int]$ObserveSeconds = 30
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ModulePath)) {
    $ModulePath = Join-Path $PSScriptRoot '../../../packages/cli/native-tools/windows-msix/WindowsMsixAcceptance.psm1'
}
Import-Module (Join-Path $PSScriptRoot 'WindowsMsixSmoke.psm1') -Force
Import-Module $ModulePath -Force
$build = Get-Content -LiteralPath $SourceMetadata -Raw | ConvertFrom-Json
if ($build.sourceGitSha -cne $SourceGitSha -or $build.runId -ne $env:GITHUB_RUN_ID -or
    $build.architecture -cne $Architecture -or $build.template -cne $env:MPGD_WINDOWS_SMOKE_TEMPLATE) {
    throw 'KIT acceptance requires this run, template and exact checkout.'
}
if ((Get-FileHash -LiteralPath $ModulePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.toolingSha256) {
    throw 'Acceptance tooling differs from the packed CLI consumer artifact.'
}
$source = @{ GitSha = $build.sourceGitSha; RunId = $build.runId; Owner = 'kit-generated-starter'; Workflow = $SourceWorkflow }
$inspect = {
    param($Directory, $Receipt)
    $bundle = Join-Path $Directory 'wwwroot\assets\game.js'
    if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.gameBundleSha256) {
        throw 'The packaged web game differs from the generated starter build.'
    }
}.GetNewClosure()
$readiness = {
    param($Installed, $Receipt)
    $Receipt.generatedGameLoaded = $false
    $readyLog = Join-Path $env:LOCALAPPDATA "Packages\$($Installed.PackageFamilyName)\LocalState\starter-ready.json"
    if (Test-Path -LiteralPath $readyLog) {
        $state = Read-AtomicJson $readyLog
        $Receipt.generatedGameLoaded = Test-StarterReadiness $state $build.gameBundleSha256
        $contracts = @($state.nativeHostContracts)
        $Receipt.nativeHostContractsVerified = $contracts.Count -eq 2 -and
            $contracts[0].itemId -ceq 'puzzle.coins' -and $contracts[1].itemId -ceq 'tower.coins' -and
            @($contracts | Where-Object { $_.passed -ne $true }).Count -eq 0 -and
            $state.nativeBridge.passed -eq $true -and $state.nativeBridge.itemId -ceq 'tower.coins' -and
            $state.staleDocumentMessageRejected -eq $true
        $Receipt.generatedGameLoaded = $Receipt.generatedGameLoaded -and $Receipt.nativeHostContractsVerified
        if ($Receipt.generatedGameLoaded) { $Receipt.generatedGame = $state }
    }
    return [bool]$Receipt.generatedGameLoaded
}.GetNewClosure()
$collect = {
    param($Installed, $Directory, $Receipt)
    $readyLog = Join-Path $env:LOCALAPPDATA "Packages\$($Installed.PackageFamilyName)\LocalState\starter-ready.json"
    Copy-Item -LiteralPath $readyLog -Destination (Join-Path $Directory 'starter-ready.json')
}
Invoke-MsixNativeAcceptance -PackageDirectory $PackageDirectory -OutputDirectory $OutputDirectory -Architecture $Architecture -Source $source -Identity MPGD.KitStarterSmoke -Publisher "CN=MPGD Kit CI" -ObserveSeconds $ObserveSeconds -InspectPayload $inspect -TestReadiness $readiness -CollectEvidence $collect -ReceiptFields @{ template = $build.template; generatedGameBundleSha256 = $build.gameBundleSha256; generatedGameLoaded = $false; acceptanceToolingSha256 = $build.toolingSha256 }
