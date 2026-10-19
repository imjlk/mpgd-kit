declare module 'virtual:mpgd-ait-runtime-config' {
  const runtimeConfig: Readonly<{
    readonly appName: string;
    readonly adGroupIds: Readonly<Record<string, string>>;
    readonly adPlacementTypes: Readonly<Record<
      string,
      import('@mpgd/adapter-ait/ad-config').AitAdPlacementType
    >>;
    /** Catalog products sold on Apps in Toss (`platformProductIds.ait`), read at build time. */
    readonly iapProducts: readonly import('@mpgd/adapter-ait').AitIapProductConfig[];
    /** Notifications v2 topics mapped for Apps in Toss (`targets.ait`), read at build time. */
    readonly notificationTopics: Readonly<Record<
      string,
      import('@mpgd/adapter-ait/notification-config').AitNotificationTopicMapping
    >>;
  }>;

  export default runtimeConfig;
}
