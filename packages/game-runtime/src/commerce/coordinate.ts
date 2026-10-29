import type { PlatformGateway } from '@mpgd/platform';
import {
  createCoordinatedCommerceProvider,
  type CoordinatedCommerceOptions,
  type CoordinatedCommerceProvider,
} from './index.js';

/**
 * The one rule for when a gateway's commerce joins the shared full-screen
 * scope, with or without an ad provider: only when something trusted can end a
 * purchase's lease (the provider's own `presentation` facts, the game's
 * `purchasePresentation` source, or a trusted classifier). Otherwise the
 * gateway keeps its commerce provider unchanged, so a provider without facts
 * (an adapter or plugin from before them) never meets the strict
 * `presentation-unavailable` refusal.
 */
export function coordinateGatewayCommerce(
  gateway: PlatformGateway,
  options: Omit<CoordinatedCommerceOptions, 'provider'>,
): CoordinatedCommerceProvider | undefined {
  const source = gateway.commerce;
  if (source === undefined || (options.purchasePresentation === undefined
    && source.presentation === undefined && options.classifyPurchasePresentation === undefined)) {
    return undefined;
  }
  return createCoordinatedCommerceProvider({ ...options, provider: source });
}
