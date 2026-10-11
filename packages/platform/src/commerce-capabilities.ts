import type { CommerceCapabilities } from './index.js';

// Pure capability helpers shared by `./commerce` and `./capability-conformance`.
// This file imports no validator so the conformance runner stays free of typia.

export interface LegacyCommerceCapabilities {
  readonly nativeIap: boolean;
  readonly subscriptionIap: boolean;
}

/** Transition rule for the boolean `PlatformCapabilities` flags. */
export function deriveLegacyCommerceCapabilities(
  capabilities: CommerceCapabilities,
): LegacyCommerceCapabilities {
  return {
    nativeIap: capabilities.availability === 'available'
      && (capabilities.purchase.consumable || capabilities.purchase.durable),
    subscriptionIap: capabilities.purchase.subscription,
  };
}

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
