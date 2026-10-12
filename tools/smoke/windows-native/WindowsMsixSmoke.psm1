# CI-only KIT starter acceptance; payload/process checks adapted from mpgd-games PR #96.
Set-StrictMode -Version Latest

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "Not a PE image: $Path"
    }
    $offset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($offset -lt 64 -or $offset -gt $bytes.Length - 6 -or
        $bytes[$offset] -ne 0x50 -or $bytes[$offset + 1] -ne 0x45 -or
        $bytes[$offset + 2] -ne 0 -or $bytes[$offset + 3] -ne 0) {
        throw "Invalid PE header: $Path"
    }
    return [BitConverter]::ToUInt16($bytes, $offset + 4)
}

function Test-PathWithin {
    param([string]$Path, [string]$Root)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    return [IO.Path]::GetFullPath($Path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-MsixPayload {
    param([string]$Directory, [string]$Identity, [string]$Publisher,
          [ValidateSet('x64', 'ARM64')][string]$Architecture)
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $Directory 'AppxManifest.xml') -Raw
    $packageIdentity = $manifest.Package.Identity
    if ($packageIdentity.Name -cne $Identity -or $packageIdentity.Publisher -cne $Publisher -or
        $packageIdentity.ProcessorArchitecture -ine $Architecture) {
        throw 'MSIX identity, publisher or architecture does not match the selected game.'
    }
    $applications = @($manifest.Package.Applications.Application)
    if ($applications.Count -ne 1) { throw 'Expected one packaged native application.' }
    $application = $applications[0]
    $executable = [string]$application.Executable
    if (-not $executable.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::IsPathRooted($executable) -or $executable -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'The manifest does not name a safe relative native executable.'
    }
    $executablePath = Join-Path $Directory $executable
    if (-not (Test-PathWithin $executablePath $Directory)) { throw 'Executable escapes the package.' }
    $machine = @{ x64 = 0x8664; ARM64 = 0xAA64 }[$Architecture]
    if ((Get-PeMachine $executablePath) -ne $machine) { throw 'Wrong native executable architecture.' }
    $appRoot = Split-Path -Parent $executablePath
    foreach ($name in @('hostfxr.dll', 'hostpolicy.dll', 'coreclr.dll', 'System.Private.CoreLib.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $appRoot $name) -PathType Leaf)) {
            throw "Missing bundled runtime file: $name"
        }
    }
    if ((Get-PeMachine (Join-Path $appRoot 'coreclr.dll')) -ne $machine) {
        throw 'The package contains another architecture''s .NET runtime.'
    }
    $processName = [IO.Path]::GetFileNameWithoutExtension($executable)
    $runtime = Get-Content -LiteralPath (Join-Path $appRoot "$processName.runtimeconfig.json") -Raw | ConvertFrom-Json
    $options = $runtime.runtimeOptions
    $included = $options.PSObject.Properties['includedFrameworks']
    if ($null -ne $options.PSObject.Properties['framework'] -or
        $null -ne $options.PSObject.Properties['frameworks'] -or $null -eq $included -or
        @($included.Value | Where-Object { $_.name -eq 'Microsoft.NETCore.App' }).Count -eq 0) {
        throw 'The native package is framework-dependent or does not include Microsoft.NETCore.App.'
    }
    return @{
        Identity = [string]$packageIdentity.Name; Publisher = [string]$packageIdentity.Publisher
        Version = [string]$packageIdentity.Version; Architecture = $Architecture
        AppId = [string]$application.Id; Executable = $executable; ProcessName = $processName
    }
}

function Get-DescendantProcesses {
    param([int]$RootProcessId, [object[]]$Processes)
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($process in $Processes) {
            if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {
                $changed = $true
            }
        }
    } while ($changed)
    return @($Processes | Where-Object {
        [int]$_.ProcessId -ne $RootProcessId -and $ids.Contains([int]$_.ProcessId)
    })
}

function Test-StarterReadiness {
    param($State, [string]$BundleSha256)
    return $State.url -ceq 'https://starter.mpgd.invalid/index.html' -and
        $State.bundleSha256 -ceq $BundleSha256 -and $State.canvasWidth -gt 0 -and
        $State.canvasHeight -gt 0 -and $State.gameBundleLoaded -eq $true -and
        $State.bootError -eq $false -and $State.errors.Count -eq 0 -and
        ([DateTime]::UtcNow - [DateTime]::Parse($State.observedAt).ToUniversalTime()).TotalSeconds -lt 5
}

Export-ModuleMember -Function Get-PeMachine, Test-PathWithin, Assert-MsixPayload, Get-DescendantProcesses, Test-StarterReadiness
