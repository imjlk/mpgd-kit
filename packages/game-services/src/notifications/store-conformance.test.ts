import { runNotificationStoreConformance } from './store-conformance.js';
import { createInMemoryNotificationStore } from './store.js';

await runNotificationStoreConformance(() => createInMemoryNotificationStore());

console.info('In-memory notification store conformance passed.');
