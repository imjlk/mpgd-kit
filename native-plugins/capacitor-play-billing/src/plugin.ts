import { registerPlugin } from '@capacitor/core';

import type { CapacitorPlayBillingPlugin } from './definitions.js';

export const CapacitorPlayBilling =
  registerPlugin<CapacitorPlayBillingPlugin>('CapacitorPlayBilling');
