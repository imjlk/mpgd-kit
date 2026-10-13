declare module '#mpgd-platform-gateway' {
  export function createBuildGateway(
    runtime: import('./runtimeDetector').RuntimeConfig,
  ): Promise<import('@mpgd/platform').PlatformGateway>;
}
