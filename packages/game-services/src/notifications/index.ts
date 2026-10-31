/**
 * Notifications v2 server for `@mpgd/game-services` (notifications v2 RFC,
 * "Server"): the provider registry, the endpoint registry, consent records
 * and the notices API, sends through the policy gate, server reminders and
 * the scheduler (consent notice pushes, paced due rows), and the remote
 * delivery provider contract, with the FCM provider, and the copy resolver
 * port that chooses a send's localized title and body.
 */
export * from './copy.js';
export * from './delivery-provider.js';
export * from './fcm.js';
export * from './registry.js';
export * from './service.js';
export * from './store.js';
