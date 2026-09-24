import type { CapacitorServiceProvider } from '@mpgd/adapter-capacitor';
import type { PlatformProviderAvailability, PlatformProviderFeature } from '@mpgd/platform';
import type { FeatureAvailabilityReason, PlatformFeature } from '@mpgd/target-config';

const feature: PlatformProviderFeature = 'subscriptionIap';
const readiness: PlatformProviderAvailability = 'configuration-required';
const targetFeature: PlatformFeature = 'subscriptions';
const reason: FeatureAvailabilityReason = 'temporarily-unavailable';
const provider: CapacitorServiceProvider = {
  id: 'packed-store',
  features: [feature],
  methods: ['commerce.purchase'],
  bridge: {
    async request(input) {
      return {
        id: input.id,
        ok: false,
        error: {
          code: 'NOT_CONFIGURED',
          message: 'Unavailable.',
          retryable: false,
        },
      };
    },
  },
  async getAvailability() {
    return { [feature]: readiness };
  },
};

void provider;
void targetFeature;
void reason;
