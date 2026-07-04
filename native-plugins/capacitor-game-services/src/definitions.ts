import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';

export interface CapacitorGameServicesPlugin {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}
