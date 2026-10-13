import {
  createDevvitCommerceProducts,
  createDevvitPlatformGateway,
  type DevvitGatewayCommerceOptions,
} from '@mpgd/adapter-devvit';
import { createDevvitWebPaymentsClient } from '@mpgd/adapter-devvit/web';
import type { ProductCatalog } from '@mpgd/catalog';
import productCatalogJson from '@mpgd/catalog/catalog.json';
import type { PlatformGateway } from '@mpgd/platform';

import type { RuntimeConfig } from '../runtimeDetector';

const productCatalog = productCatalogJson as ProductCatalog;

/**
 * Reddit gateway with the Devvit commerce v2 provider installed when the
 * catalog names Reddit SKUs (`platformProductIds.reddit`, the same key the
 * Devvit server reads, whatever the deployment target is called). The webview
 * only opens the checkout; the paid-order list comes from the server bridge,
 * which serves it only after the Devvit server opted in
 * (`permissions.payments` plus the same catalog SKUs), and the grant comes
 * from the fulfillment handler's ledger entry. Without SKUs the gateway
 * offers no `commerce` provider at all.
 */
export async function createBuildGateway(runtime: RuntimeConfig): Promise<PlatformGateway> {
  const commerce = createCommerceOptions();
  return createDevvitPlatformGateway({
    appVersion: runtime.appVersion,
    buildId: runtime.buildId,
    ...(commerce === undefined ? {} : { commerce }),
  });
}

function createCommerceOptions(): DevvitGatewayCommerceOptions | undefined {
  const products = createDevvitCommerceProducts(productCatalog);
  if (products.length === 0) {
    return undefined;
  }
  return {
    products,
    client: createDevvitWebPaymentsClient(),
    onCheckoutError: (error) => {
      console.warn('[devvit] checkout answered without a usable result.', error);
    },
  };
}
