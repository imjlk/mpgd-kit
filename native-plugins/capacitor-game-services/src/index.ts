import { registerPlugin } from '@capacitor/core';

import type { CapacitorGameServicesPlugin } from './definitions.js';

export const CapacitorGameServices =
  registerPlugin<CapacitorGameServicesPlugin>('CapacitorGameServices');

export * from './definitions.js';
