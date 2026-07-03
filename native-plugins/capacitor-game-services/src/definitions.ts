import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge-protocol';

export interface CapacitorGameServicesPlugin {
  request(input: BridgeRequest): Promise<BridgeResponse>;
}
