# Reusable isolated Windows MSIX acceptance. Game policy belongs to the caller.
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

function Read-AtomicJson {
    param([string]$Path)
    # Permit the host's atomic rename while this sample reads the previous file.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = [IO.StreamReader]::new($stream)
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) }
    finally { $reader.Dispose() }
}
function Assert-MsixAcceptanceSource {
    param([Parameter(Mandatory = $true)]$Source)
    if ($Source.GitSha -cnotmatch '^[a-f0-9]{40}$' -or [string]$Source.RunId -notmatch '^[0-9]{1,20}$' -or
        $Source.Owner -cnotmatch '^[a-z0-9][a-z0-9-]{0,63}$' -or [string]::IsNullOrWhiteSpace($Source.Workflow)) {
        throw 'Native acceptance requires a full source SHA, run ID, owner and workflow.'
    }
}
function Copy-MsixAdditionalEvidence {
    param($Receipt, [hashtable]$Fields, [string[]]$Reserved)
    foreach ($key in $Fields.Keys) {
        if ($Reserved -icontains [string]$key) {
            throw 'Additional evidence cannot overwrite native acceptance evidence.'
        }
        $Receipt[$key] = $Fields[$key]
    }
}

function Invoke-MsixNativeAcceptance {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PackageDirectory,
        [Parameter(Mandatory = $true)][string]$OutputDirectory,
        [Parameter(Mandatory = $true)][string]$Identity,
        [Parameter(Mandatory = $true)][string]$Publisher,
        [Parameter(Mandatory = $true)][ValidateSet('x64', 'ARM64')][string]$Architecture,
        [Parameter(Mandatory = $true)]$Source,
        [ValidateRange(10, 120)][int]$ObserveSeconds = 30,
        [hashtable]$ReceiptFields = @{},
        [scriptblock]$InspectPayload,
        [scriptblock]$TestReadiness,
        [scriptblock]$CollectEvidence
    )
    $ErrorActionPreference = 'Stop'
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT') {
        throw 'Native MSIX acceptance runs on an isolated GitHub Windows runner.'
    }
    $cpu = @(Get-CimInstance Win32_Processor)[0].Architecture
    $expectedCpu = @{ x64 = 9; ARM64 = 12 }[$Architecture]
    if ($cpu -ne $expectedCpu) { throw "Native $Architecture acceptance requires a matching Windows runner." }

    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    Assert-MsixAcceptanceSource $Source
    $receipt = [ordered]@{
        schemaVersion = 1; game = $Source.Owner; architecture = $Architecture; status = 'failed'
        sourceRunId = $Source.RunId; sourceGitSha = $Source.GitSha
        sourceWorkflow = $Source.Workflow
        acceptanceGitSha = $env:GITHUB_SHA
        acceptanceRun = "https://github.com/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
        startedAt = [DateTime]::UtcNow.ToString('o'); observeSeconds = $ObserveSeconds
        packageIdentityVerified = $false; selfContainedRuntimeVerified = $false
        nativeInstallationVerified = $false; nativeLaunchVerified = $false
        packagedCoreClrVerified = $false; winUiLoaded = $false; windowObserved = $false
        webViewRendererObserved = $false
        gameplayAcceptance = 'not-run'; loginPurchaseAcceptance = 'not-run'; storeUploaded = $false
        cleanupErrors = @()
    }
    $reserved = @($receipt.Keys) + @('packageSha256', 'packageFile', 'identity', 'packageVersion',
        'processId', 'loadedCoreClr', 'loadedWinUi', 'failure', 'finishedAt')
    $extraEvidence = @{}
    foreach ($key in $ReceiptFields.Keys) { $extraEvidence[$key] = $ReceiptFields[$key] }
    Copy-MsixAdditionalEvidence $receipt $extraEvidence $reserved
    $temporary = Join-Path $env:RUNNER_TEMP ('native-msix-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $installed = $null
    $certificate = $null
    $installAttempted = $false
    $hostProcess = $null
    $metadata = $null
    $started = Get-Date
    $failure = $null

    try {
        $packages = @(Get-ChildItem -LiteralPath $PackageDirectory -Filter *.msix -File -Recurse)
        if ($packages.Count -ne 1) { throw 'Expected exactly one native MSIX artifact for this architecture.' }
        $original = $packages[0].FullName
        $originalHash = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash
        $receipt.packageSha256 = $originalHash.ToLowerInvariant()
        $receipt.packageFile = $packages[0].Name
        $sdkRoot = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Windows Kits\10\bin'
        $tools = @(Get-ChildItem -Path (Join-Path $sdkRoot '*\*\MakeAppx.exe') -File |
            Where-Object { $_.Directory.Name -in @($Architecture.ToLowerInvariant(), 'x64') } |
            Sort-Object @{ Expression = { [version]$_.Directory.Parent.Name }; Descending = $true },
                        @{ Expression = { $_.Directory.Name -eq $Architecture.ToLowerInvariant() }; Descending = $true })
        if ($tools.Count -eq 0) { throw 'Windows SDK MakeAppx was not found.' }
        $makeAppx = $tools[0].FullName
        $signTool = Join-Path $tools[0].DirectoryName 'signtool.exe'
        if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) { throw 'Windows SDK SignTool was not found.' }
        $inspection = Join-Path $temporary 'inspection'
        & $makeAppx unpack /p $original /d $inspection /o
        if ($LASTEXITCODE -ne 0) { throw 'MakeAppx could not inspect the package.' }
        $metadata = Assert-MsixPayload $inspection $Identity $Publisher $Architecture
        if ($null -ne $InspectPayload) {
            & $InspectPayload $inspection $extraEvidence | Out-Null
            Copy-MsixAdditionalEvidence $receipt $extraEvidence $reserved
        }
        $receipt.packageIdentityVerified = $true
        $receipt.selfContainedRuntimeVerified = $true
        $receipt.identity = $metadata.Identity
        $receipt.packageVersion = $metadata.Version

        # Refuse to replace any pre-existing installation, including another version.
        if (@(Get-AppxPackage -Name $metadata.Identity).Count -ne 0) {
            throw 'The selected game is already installed; this is not a clean acceptance runner.'
        }
        $copy = Join-Path $temporary 'test-signed.msix'
        Copy-Item -LiteralPath $original -Destination $copy
        $certificate = New-SelfSignedCertificate -Type Custom -Subject $metadata.Publisher -KeyUsage DigitalSignature -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
        & $signTool sign /fd SHA256 /sha1 $certificate.Thumbprint $copy
        if ($LASTEXITCODE -ne 0) { throw 'Could not test-sign the package copy.' }
        $publicCertificate = Join-Path $temporary 'test-signing.cer'
        Export-Certificate -Cert $certificate -FilePath $publicCertificate | Out-Null
        Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
        $installAttempted = $true
        Add-AppxPackage -Path $copy
        $matches = @(Get-AppxPackage -Name $metadata.Identity)
        if ($matches.Count -ne 1 -or $matches[0].Version.ToString() -cne $metadata.Version) {
            throw 'Installed package differs from the inspected artifact.'
        }
        $installed = $matches[0]
        $receipt.nativeInstallationVerified = $true
        $hostLog = Join-Path $env:LOCALAPPDATA "Packages\$($installed.PackageFamilyName)\LocalState\host-error.log"
        $expectedExecutable = Join-Path $installed.InstallLocation $metadata.Executable
        $started = Get-Date
        Start-Process -FilePath "shell:AppsFolder\$($installed.PackageFamilyName)!$($metadata.AppId)" -WindowStyle Hidden
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $readyAt = $null
        while ($clock.Elapsed.TotalSeconds -lt (60 + $ObserveSeconds)) {
            Start-Sleep -Seconds 1
            if (Test-Path -LiteralPath $hostLog) { throw 'The installed host recorded a startup exception.' }
            $candidates = @(Get-Process -Name $metadata.ProcessName -ErrorAction SilentlyContinue | Where-Object {
                $_.StartTime -ge $started -and $_.MainModule.FileName -ieq $expectedExecutable
            })
            if ($candidates.Count -gt 1) { throw 'Multiple newly activated native host processes were found.' }
            if ($candidates.Count -eq 0) {
                if ($null -ne $readyAt -or $clock.Elapsed.TotalSeconds -gt 60) { throw 'The installed native host exited or never started.' }
                continue
            }
            $hostProcess = $candidates[0]
            $modules = @($hostProcess.Modules)
            $core = @($modules | Where-Object { $_.ModuleName -ieq 'coreclr.dll' })
            $xaml = @($modules | Where-Object { $_.ModuleName -ieq 'Microsoft.UI.Xaml.dll' })
            $receipt.packagedCoreClrVerified = $core.Count -eq 1 -and (Test-PathWithin $core[0].FileName $installed.InstallLocation)
            $receipt.winUiLoaded = $xaml.Count -eq 1 -and (Test-PathWithin $xaml[0].FileName $installed.InstallLocation)
            $receipt.windowObserved = $hostProcess.MainWindowHandle -ne [IntPtr]::Zero
            $children = @(Get-DescendantProcesses $hostProcess.Id @(Get-CimInstance Win32_Process))
            $renderers = @($children | Where-Object {
                $_.Name -ieq 'msedgewebview2.exe' -and $_.CommandLine -match '(^|\s)--type=renderer(\s|$)'
            })
            $receipt.webViewRendererObserved = $renderers.Count -gt 0
            $applicationReady = $true
            if ($null -ne $TestReadiness) {
                $applicationReady = & $TestReadiness $installed $extraEvidence
                if ($applicationReady -isnot [bool]) { throw 'Application readiness callback must return one Boolean.' }
                Copy-MsixAdditionalEvidence $receipt $extraEvidence $reserved
            }
            $ready = $receipt.packagedCoreClrVerified -and $receipt.winUiLoaded -and $receipt.windowObserved -and $receipt.webViewRendererObserved -and $applicationReady
            if (-not $ready) {
                if ($null -ne $readyAt -or $clock.Elapsed.TotalSeconds -gt 60) {
                    throw 'The installed host did not sustain packaged CLR, WinUI, a native window and a WebView2 renderer.'
                }
                continue
            }
            if ($null -eq $readyAt) {
                $readyAt = $clock.Elapsed.TotalSeconds
                $receipt.processId = $hostProcess.Id
                $receipt.loadedCoreClr = $core[0].FileName
                $receipt.loadedWinUi = $xaml[0].FileName
            }
            if ($clock.Elapsed.TotalSeconds - $readyAt -ge $ObserveSeconds) { break }
        }
        if ($null -eq $readyAt -or $clock.Elapsed.TotalSeconds - $readyAt -lt $ObserveSeconds) {
            throw 'Native readiness was not observed for the required duration.'
        }
        if ((Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash -cne $originalHash) {
            throw 'The original unsigned Store artifact changed during acceptance.'
        }
        if (Test-Path -LiteralPath $hostLog) { throw 'The installed host recorded a startup exception.' }
        $receipt.nativeLaunchVerified = $true
        if ($null -ne $CollectEvidence) {
            & $CollectEvidence $installed $OutputDirectory $extraEvidence | Out-Null
            Copy-MsixAdditionalEvidence $receipt $extraEvidence $reserved
        }
        $receipt.status = 'passed'
    } catch {
        $failure = $_.Exception.Message
        $receipt.failure = $failure
        if ($null -ne $installed) {
            $log = Join-Path $env:LOCALAPPDATA "Packages\$($installed.PackageFamilyName)\LocalState\host-error.log"
            if (Test-Path -LiteralPath $log) { Copy-Item -LiteralPath $log -Destination (Join-Path $OutputDirectory 'host-error.log') }
        }
        $events = @()
        foreach ($name in @('Application', 'Microsoft-Windows-AppModel-Runtime/Admin', 'Microsoft-Windows-AppXDeploymentServer/Operational')) {
            $events += @(Get-WinEvent -FilterHashtable @{ LogName = $name; StartTime = $started; Level = 1, 2, 3 } -ErrorAction SilentlyContinue |
                Select-Object -First 10 TimeCreated, ProviderName, Id, LevelDisplayName, Message)
        }
        ConvertTo-Json -InputObject $events -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'windows-events.json') -Encoding UTF8
    } finally {
        # Clean up only this invocation's package/process and exact generated certificate.
        if ($null -ne $hostProcess) {
            $current = Get-Process -Id $hostProcess.Id -ErrorAction SilentlyContinue
            if ($null -ne $current -and $current.StartTime -eq $hostProcess.StartTime) {
                Stop-Process -Id $current.Id -ErrorAction SilentlyContinue
            }
        }
        if ($installAttempted -and $null -ne $metadata) {
            try {
                foreach ($package in @(Get-AppxPackage -Name $metadata.Identity)) {
                    if ($package.Version.ToString() -ceq $metadata.Version) {
                        Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
                    }
                }
            } catch { $receipt.cleanupErrors += $_.Exception.Message }
        }
        if ($null -ne $certificate) {
            try {
                $trustPath = "Cert:\LocalMachine\TrustedPeople\$($certificate.Thumbprint)"
                if (Test-Path -LiteralPath $trustPath) { Remove-Item -LiteralPath $trustPath -ErrorAction Stop }
                Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey -ErrorAction Stop
            } catch { $receipt.cleanupErrors += $_.Exception.Message }
        }
        if ($receipt.cleanupErrors.Count -gt 0) { $receipt.status = 'failed' }
        $receipt.finishedAt = [DateTime]::UtcNow.ToString('o')
        $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'native-smoke-receipt.json') -Encoding UTF8
    }
    if ($receipt.status -ne 'passed') { throw "Native MSIX acceptance failed: $failure; cleanup errors: $($receipt.cleanupErrors.Count)" }
    Write-Output "Installed $Identity ($Architecture): packaged CLR, WinUI window, WebView2 and application readiness sustained for $ObserveSeconds seconds."

}

Export-ModuleMember -Function Get-PeMachine, Test-PathWithin, Assert-MsixPayload, Get-DescendantProcesses, Read-AtomicJson, Assert-MsixAcceptanceSource, Invoke-MsixNativeAcceptance
