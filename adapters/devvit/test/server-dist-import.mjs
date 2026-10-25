const server = await import('../dist/server/index.js');

for (const exportName of [
  'normalizeDevvitFulfillmentOrder',
  'normalizeDevvitRefundOrder',
  'createDevvitPostOperationCoordinator',
  'createDevvitRedisPostOperationStore',
  'defineDevvitPostOperation',
  'createDevvitRedisNotificationStore',
  'createDevvitNotificationDeliveryProvider',
  'createDevvitNotificationProviderEntry',
  'createDevvitNotificationService',
  'devvitNotificationSession',
  'createDevvitServerNotificationProvider',
  'createDevvitNotificationsV2BridgeHandler',
  'createDevvitNotificationsBackendBridgeHandler',
]) {
  if (typeof server[exportName] !== 'function') {
    throw new Error(`Missing @mpgd/adapter-devvit/server export: ${exportName}`);
  }
}

console.log('@mpgd/adapter-devvit/server Node ESM import passed.');
