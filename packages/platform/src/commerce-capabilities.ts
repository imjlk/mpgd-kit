import type { CommerceCapabilities } from './index.js';

// Pure capability helpers shared by `./commerce` and `./capability-conformance`.
// This file imports no validator so the conformance runner stays free of typia.

/** A fresh all-false snapshot; callers must not share or mutate a returned object. */
export function createUnsupportedCommerceCapabilities(): CommerceCapabilities {
  return {
    purchase: { consumable: false, durable: false, subscription: false, quantity: false },
    catalog: { products: false, offers: false, localizedPrice: false },
    lifecycle: {
      availablePurchases: false,
      pending: false,
      restore: false,
      events: false,
      finish: 'none',
    },
    authority: { evidence: 'client-token', accountBinding: 'optional' },
    availability: 'unsupported',
  };
}
