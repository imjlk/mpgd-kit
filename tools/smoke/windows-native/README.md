# Generated KIT starter in an installed WinUI MSIX

The Windows consumer job creates a standalone game under a path containing spaces and installs
the current checkout's packed npm artifacts. It builds the game and Microsoft Store PWA, then
Build-StarterMsix.ps1 embeds that exact generated web bundle in this CI-only WinUI/WebView2 host.
This host is not shipped by create-game. Its native bridge exercises fixture callbacks, without
performing real Store authentication, checkout or backend grants.

The build uses a pinned .NET SDK, self-contained .NET and Windows App SDK runtimes, and locked NuGet
dependencies. x64 and ARM64 packages are built on Windows. Separate windows-latest and windows-11-arm
jobs install each package on its native CPU; a skipped/failed native matrix fails ci-required.

Each acceptance job checks package identity/PE/runtime, signs only a temporary copy, activates the
installed app, and observes packaged CLR, WinUI, a window and the host's WebView2 renderer for 30 seconds.
The host probes the actual generated page continuously: the game bundle must load, the Phaser canvas
must have nonzero dimensions, and JavaScript/bootstrap errors must be absent. The probe's bundle hash
must match both the build receipt and unpacked MSIX. Stale probes fail. Readiness is written atomically.

The original unsigned package hash, exact checkout/run, generated bundle hash, loaded modules and
cleanup results are saved in windows-starter-native-x64/ARM64 artifacts for 30 days. Unsigned packages
are retained for 7 days. No private signing key is uploaded. Existing installations are never replaced.
The installer/runtime/process/cleanup engine is shipped once by @mpgd/cli in
native-tools/windows-msix/WindowsMsixAcceptance.psm1. The standalone consumer imports
getMicrosoftStoreNativeAcceptanceModulePath from @mpgd/cli/windows-native-tools and copies the
installed module into its artifact; native jobs verify its hash and execute that packed module.
Game CI imports the same engine and keeps game identity and artifact-source policy in its caller.

This verifies installed startup and generated game bootstrap. Gameplay, Store installation, login,
purchase/restore and game-owned host behavior need their separate game acceptance. No Store upload
or submission is performed. Native jobs run with read-only repository permissions and no Store secrets.

To run the non-installing regression checks locally on Windows:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/smoke/windows-native/WindowsMsixSmoke.Tests.ps1

The policy applies only to that process. Actual packaging/signing/installing require isolated GitHub
Windows runners. The shared ci workflow runs the full consumer and native matrix for prepared scope.

## Reuse from game CI

Locate the module through the installed CLI subpath, then Import-Module that absolute path in
Windows PowerShell 5.1. Invoke-MsixNativeAcceptance requires PackageDirectory, OutputDirectory,
Identity, Publisher, Architecture and Source. Source contains GitSha (full lowercase commit),
RunId, Owner (game slug) and Workflow. The caller must verify artifact provenance before invoking it.

Optional hooks add game-specific acceptance without duplicating the installer:

- InspectPayload receives the unpacked directory and an additional-evidence hashtable before signing.
- TestReadiness receives the installed package and additional evidence; it must return one Boolean.
- CollectEvidence receives the installed package, output directory and additional evidence after startup.
- ReceiptFields seeds additional evidence. Hooks cannot replace standard native/source/hash/cleanup fields.

Hooks are trusted game-owned code. They run only on isolated GitHub Windows runners. The engine always
requires the baseline native/runtime/window/renderer checks and 30 seconds of sustained readiness by
default, even when a game supplies a custom probe. Normal installation, certificates and original files
remain owned and cleaned by the engine; an existing installation causes a failure.

References: [self-contained Windows App SDK deployment](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/self-contained-deploy/deploy-self-contained-apps)
and [WebView2 local content mapping](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content).
