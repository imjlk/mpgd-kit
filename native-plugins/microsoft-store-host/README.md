# Microsoft Store WinUI integration

Windows SDK imports live in this native plugin source directory. The existing
`@mpgd/cli` build copies `windows/*.cs` into its shipped
`dist/windows-host/WinUI` assets. This is a source distribution inside
the CLI; it does not introduce a separate npm or NuGet package.

The SDK-independent core and integration guide live under
[`packages/cli/native-tools/windows-host`](../../packages/cli/native-tools/windows-host/README.md).
CI compiles and executes the installed package's WinUI adapter in x64 and ARM64
hosts with fixture operations. Real authentication, SKU mappings and grants
remain game-owned callbacks.
