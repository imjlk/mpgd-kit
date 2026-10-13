[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GameDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT') {
    throw 'Build the CI host only on an isolated GitHub Windows runner.'
}
$web = Join-Path $GameDirectory 'dist'
$bundle = Join-Path $web 'assets\game.js'
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { throw 'Missing generated game bundle.' }
$gameHash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
$module = Join-Path $OutputDirectory 'native-tooling\WindowsMsixAcceptance.psm1'
$toolingHash = (Get-FileHash -LiteralPath $module -Algorithm SHA256).Hash.ToLowerInvariant()
$hostRoot = Join-Path $env:RUNNER_TEMP ('kit-native-host-' + [Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host') -Destination $hostRoot -Recurse
Copy-Item -LiteralPath (Join-Path $OutputDirectory 'native-tooling/windows-host') -Destination (Join-Path $hostRoot 'SharedHost') -Recurse
Copy-Item -LiteralPath $web -Destination (Join-Path $hostRoot 'wwwroot') -Recurse
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path (Join-Path $hostRoot 'Assets') | Out-Null
foreach ($asset in @(@('StoreLogo', 50), @('Square150x150Logo', 150), @('Square44x44Logo', 44))) {
    $bitmap = [Drawing.Bitmap]::new([int]$asset[1], [int]$asset[1])
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([Drawing.Color]::FromArgb(15, 23, 42))
        $bitmap.Save((Join-Path $hostRoot ('Assets\' + $asset[0] + '.png')), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
$project = Join-Path $hostRoot 'KitStarterHost.csproj'
foreach ($arch in @('x64', 'ARM64')) {
    $runtime = @{ x64 = 'win-x64'; ARM64 = 'win-arm64' }[$arch]
    $destination = [IO.Path]::GetFullPath((Join-Path $OutputDirectory $arch)) + [IO.Path]::DirectorySeparatorChar
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    & msbuild $project /t:Restore /p:RestoreLockedMode=true /p:Configuration=Release "/p:Platform=$arch" "/p:RuntimeIdentifier=$runtime"
    if ($LASTEXITCODE -ne 0) { throw "WinUI $arch restore failed." }
    & msbuild $project /p:Configuration=Release "/p:Platform=$arch" "/p:RuntimeIdentifier=$runtime" /p:GenerateAppxPackageOnBuild=true "/p:AppxPackageDir=$destination" /p:AppxBundle=Never /p:AppxPackageSigningEnabled=false
    if ($LASTEXITCODE -ne 0) { throw "WinUI $arch MSIX build failed." }
    Copy-Item -LiteralPath (Join-Path $hostRoot 'packages.lock.json') -Destination (Join-Path $destination 'packages.lock.json')
    @{
        architecture = $arch; sourceGitSha = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID
        gameBundleSha256 = $gameHash; toolingSha256 = $toolingHash
        origin = 'KIT CLI packed consumer generated game'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'package-build.json') -Encoding UTF8
}
