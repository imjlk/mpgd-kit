/**
 * Notifications v2 server for `@mpgd/game-services` (notifications v2 RFC,
 * "Server"): the provider registry, the endpoint registry, consent records
 * and the notices API, sends through the policy gate, and the remote
 * delivery provider contract. The FCM provider lives in `./notifications/fcm`.
 */
export * from './delivery-provider.js';
export * from './registry.js';
export * from './service.js';
export * from './store.js';
