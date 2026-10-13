# KIT starter-specific readiness, using the shipped shared acceptance engine.
Import-Module (Join-Path $PSScriptRoot '../../../packages/cli/native-tools/windows-msix/WindowsMsixAcceptance.psm1') -Force
function Test-StarterReadiness {
    param($State, [string]$BundleSha256)
    return $State.url -ceq 'https://starter.mpgd.invalid/index.html' -and
        $State.bundleSha256 -ceq $BundleSha256 -and $State.canvasWidth -gt 0 -and
        $State.canvasHeight -gt 0 -and $State.gameBundleLoaded -eq $true -and
        $State.bootError -eq $false -and $State.errors.Count -eq 0 -and
        ([DateTime]::UtcNow - [DateTime]::Parse($State.observedAt).ToUniversalTime()).TotalSeconds -lt 5
}


Export-ModuleMember -Function Get-PeMachine, Test-PathWithin, Assert-MsixPayload, Get-DescendantProcesses, Test-StarterReadiness
