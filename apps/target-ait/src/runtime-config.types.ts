declare module 'virtual:mpgd-ait-runtime-config' {
  const runtimeConfig: Readonly<{
    readonly appName: string;
    readonly adGroupIds: Readonly<Record<string, string>>;
    readonly adPlacementTypes: Readonly<Record<
      string,
      import('@mpgd/adapter-ait/ad-config').AitAdPlacementType
    >>;
  }>;

  export default runtimeConfig;
}
