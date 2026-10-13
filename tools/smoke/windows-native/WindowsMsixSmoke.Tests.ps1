Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'WindowsMsixSmoke.psm1') -Force
$root = Join-Path ([IO.Path]::GetTempPath()) ('msix-smoke-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$script:checks = 0
function Assert-True {
    param([bool]$Value, [string]$Message)
    if (-not $Value) { throw $Message }
    $script:checks++
}
function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern)
    try { & $Action | Out-Null } catch {
        Assert-True ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)"
        return
    }
    throw "Expected a failure matching $Pattern"
}
function Write-Pe {
    param([string]$Path, [int]$Machine)
    $bytes = [byte[]]::new(256)
    $bytes[0] = 0x4D; $bytes[1] = 0x5A
    [BitConverter]::GetBytes([int]128).CopyTo($bytes, 0x3C)
    $bytes[128] = 0x50; $bytes[129] = 0x45
    [BitConverter]::GetBytes([UInt16]$Machine).CopyTo($bytes, 132)
    [IO.File]::WriteAllBytes($Path, $bytes)
}
function Write-Runtime {
    param($Options)
    @{ runtimeOptions = $Options } | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $root 'Host.runtimeconfig.json') -Encoding UTF8
}
try {
    $publisher = 'CN=MPGD Kit CI'
    $xml = '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity Name="MPGD.KitStarterSmoke" Publisher="' + $publisher + '" Version="1.2.1.0" ProcessorArchitecture="x64"/><Applications><Application Id="App" Executable="Host.exe"/></Applications></Package>'
    Set-Content -LiteralPath (Join-Path $root 'AppxManifest.xml') -Value $xml -Encoding UTF8
    Write-Pe (Join-Path $root 'Host.exe') 0x8664
    Write-Pe (Join-Path $root 'coreclr.dll') 0x8664
    foreach ($name in @('hostfxr.dll', 'hostpolicy.dll', 'System.Private.CoreLib.dll')) {
        Set-Content -LiteralPath (Join-Path $root $name) -Value fixture
    }
    $included = @{ includedFrameworks = @(@{ name = 'Microsoft.NETCore.App'; version = '8.0.31' }) }
    Write-Runtime $included
    $metadata = Assert-MsixPayload $root 'MPGD.KitStarterSmoke' $publisher x64
    Assert-True ($metadata.ProcessName -eq 'Host') 'Valid self-contained native payload was refused.'
    Assert-Throws { Assert-MsixPayload $root 'another.game' $publisher x64 } 'identity'
    Assert-Throws { Assert-MsixPayload $root 'MPGD.KitStarterSmoke' 'CN=another' x64 } 'identity'
    Assert-Throws { Assert-MsixPayload $root 'MPGD.KitStarterSmoke' $publisher ARM64 } 'architecture'
    Write-Pe (Join-Path $root 'coreclr.dll') 0xAA64
    Assert-Throws { Assert-MsixPayload $root 'MPGD.KitStarterSmoke' $publisher x64 } 'another architecture'
    Write-Pe (Join-Path $root 'coreclr.dll') 0x8664
    Write-Runtime @{ framework = @{ name = 'Microsoft.NETCore.App' }; includedFrameworks = $included.includedFrameworks }
    Assert-Throws { Assert-MsixPayload $root 'MPGD.KitStarterSmoke' $publisher x64 } 'framework-dependent'
    Write-Runtime @{ includedFrameworks = @() }
    Assert-Throws { Assert-MsixPayload $root 'MPGD.KitStarterSmoke' $publisher x64 } 'framework-dependent'
    Write-Runtime $included
    Set-Content -LiteralPath (Join-Path $root 'AppxManifest.xml') -Value $xml.Replace('Host.exe', '..\Host.exe') -Encoding UTF8
    Assert-Throws { Assert-MsixPayload $root 'MPGD.KitStarterSmoke' $publisher x64 } 'safe relative'
    Set-Content -LiteralPath (Join-Path $root 'invalid.dll') -Value not-a-PE
    Assert-Throws { Get-PeMachine (Join-Path $root 'invalid.dll') } 'PE image'
    Write-Pe (Join-Path $root 'invalid.dll') 0x8664
    $invalid = [IO.File]::ReadAllBytes((Join-Path $root 'invalid.dll'))
    [BitConverter]::GetBytes([int]2147483647).CopyTo($invalid, 0x3C)
    [IO.File]::WriteAllBytes((Join-Path $root 'invalid.dll'), $invalid)
    Assert-Throws { Get-PeMachine (Join-Path $root 'invalid.dll') } 'Invalid PE'
    Assert-True (-not (Test-PathWithin ($root + '-other\coreclr.dll') $root)) 'Sibling prefix passed as installed runtime.'
    $children = @(Get-DescendantProcesses 10 @(
        @{ ProcessId = 11; ParentProcessId = 10 }, @{ ProcessId = 12; ParentProcessId = 11 },
        @{ ProcessId = 13; ParentProcessId = 999 }
    ))
    Assert-True ($children.Count -eq 2 -and 13 -notin $children.ProcessId) 'Unrelated WebView processes counted as this host.'
    Import-Module (Join-Path $PSScriptRoot '../../../packages/cli/native-tools/windows-msix/WindowsMsixAcceptance.psm1') -Force
    $source = @{ GitSha = ('a' * 40); RunId = '42'; Owner = 'fixture'; Workflow = '.github/workflows/ci.yml' }
    Assert-MsixAcceptanceSource $source
    $source.GitSha = 'short'
    Assert-Throws { Assert-MsixAcceptanceSource $source } 'full source SHA'
    $source.GitSha = ('a' * 40); $source.RunId = '../42'
    Assert-Throws { Assert-MsixAcceptanceSource $source } 'run ID'
    $source.RunId = '42'; $source.Owner = '../other'
    Assert-Throws { Assert-MsixAcceptanceSource $source } 'owner'
    $commonModule = Get-Module WindowsMsixAcceptance
    $baseReceipt = [ordered]@{ status = 'failed'; nativeLaunchVerified = $false }
    & $commonModule { param($Receipt) Copy-MsixAdditionalEvidence $Receipt @{ canvasLoaded = $true } @('status', 'nativeLaunchVerified') } $baseReceipt
    Assert-True ($baseReceipt.canvasLoaded -and -not $baseReceipt.nativeLaunchVerified) 'Additional evidence changed native evidence.'
    Assert-Throws { & $commonModule { param($Receipt) Copy-MsixAdditionalEvidence $Receipt @{ nativeLaunchVerified = $true } @('status', 'nativeLaunchVerified') } $baseReceipt } 'cannot overwrite'
    Assert-Throws { & $commonModule { param($Receipt) Complete-MsixAcceptanceEvidence $Receipt $null '.' @{} @('status') { throw 'collect failed' } } $baseReceipt } 'collect failed'
    Assert-True ($baseReceipt.status -eq 'failed') 'Evidence collection failure was marked passed.'
    Assert-Throws { & $commonModule { param($Receipt) Complete-MsixAcceptanceEvidence $Receipt $null '.' @{} @('status') { param($Installed, $Directory, $Fields) $Fields.status = 'passed' } } $baseReceipt } 'cannot overwrite'
    Assert-True ($baseReceipt.status -eq 'failed') 'A callback replaced the final outcome.'
    & $commonModule { param($Receipt) Complete-MsixAcceptanceEvidence $Receipt $null '.' @{} @('status') { param($Installed, $Directory, $Fields) $Fields.collected = $true } } $baseReceipt
    Assert-True ($baseReceipt.status -eq 'passed' -and $baseReceipt.collected) 'Successful evidence collection did not complete acceptance.'
    $state = [pscustomobject]@{
        url = 'https://starter.mpgd.invalid/index.html'; bundleSha256 = ('a' * 64)
        canvasWidth = 1280; canvasHeight = 720; gameBundleLoaded = $true; bootError = $false
        errors = @(); observedAt = [DateTime]::UtcNow.ToString('o')
    }
    Assert-True (Test-StarterReadiness $state ('a' * 64)) 'Valid starter readiness was refused.'
    Assert-True (-not (Test-StarterReadiness $state ('b' * 64))) 'A different game build passed.'
    $state.canvasWidth = 0
    Assert-True (-not (Test-StarterReadiness $state ('a' * 64))) 'An empty canvas passed.'
    $state.canvasWidth = 1280; $state.errors = @('bootstrap failed')
    Assert-True (-not (Test-StarterReadiness $state ('a' * 64))) 'A JavaScript failure passed.'
    $state.errors = @(); $state.bootError = $true
    Assert-True (-not (Test-StarterReadiness $state ('a' * 64))) 'A bootstrap error panel passed.'
    $state.bootError = $false; $state.observedAt = [DateTime]::UtcNow.AddSeconds(-10).ToString('o')
    Assert-True (-not (Test-StarterReadiness $state ('a' * 64))) 'Stale readiness passed.'
    Write-Output "Windows MSIX acceptance regression checks passed: $script:checks"
} finally {
    $absolute = [IO.Path]::GetFullPath($root)
    if (-not (Test-PathWithin $absolute ([IO.Path]::GetTempPath())) -or
        [IO.Path]::GetFileName($absolute) -notmatch '^msix-smoke-test-[a-f0-9]{32}$') {
        throw 'Refusing to delete an unexpected fixture directory.'
    }
    Remove-Item -LiteralPath $absolute -Recurse -Force
}
