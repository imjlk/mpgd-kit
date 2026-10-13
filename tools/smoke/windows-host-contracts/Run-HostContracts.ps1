[CmdletBinding()]
param([string]$SourceDirectory = (Join-Path $PSScriptRoot '../../../packages/cli/native-tools/windows-host'))
$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('mpgd-host-contracts-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'HostContracts.csproj') -Destination $taskRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Program.cs') -Destination $taskRoot
$project = Join-Path $taskRoot 'HostContracts.csproj'
$artifacts = Join-Path $taskRoot 'artifacts'
& dotnet build $project --configuration Release --artifacts-path $artifacts "-p:NativeHostSourceDirectory=$([IO.Path]::GetFullPath($SourceDirectory))"
if ($LASTEXITCODE -ne 0) { throw 'Native host contract fixture failed to compile.' }
$wire = Join-Path $taskRoot 'wire-results.json'
& dotnet (Join-Path $artifacts 'bin/HostContracts/release/HostContracts.dll') $wire
if ($LASTEXITCODE -ne 0) { throw 'Native host contracts failed.' }
& node (Join-Path $PSScriptRoot 'Verify-WebClient.mjs') $wire
if ($LASTEXITCODE -ne 0) { throw 'C# results are incompatible with the public web bridge client.' }
