import { registerPlugin } from '@capacitor/core';

import type { CapacitorGameServicesPlugin } from './definitions';

export const CapacitorGameServices =
  registerPlugin<CapacitorGameServicesPlugin>('CapacitorGameServices');

export * from './definitions';
