import './styles.css';

import { installAitHostBridge, type InstallAitHostBridgeOptions } from '@mpgd/adapter-ait/host';
import { installAitSafeAreaCssVariables } from '@mpgd/adapter-ait/safe-area';
import { mountAitGameBundle } from '@mpgd/adapter-ait/wrapper';

import runtimeConfig from 'virtual:mpgd-ait-runtime-config';

installAitSafeAreaCssVariables();
installAitHostBridge({
  appName: runtimeConfig.appName,
  adGroupIds: runtimeConfig.adGroupIds,
  adPlacementTypes: runtimeConfig.adPlacementTypes,
  ...iapBridgeOptions(),
  ...identityBridgeOptions(),
});

const app = document.querySelector<HTMLElement>('#app');
if (app !== null) {
  void mountAitGameBundle(app).catch((error: unknown) => {
    console.error('AIT game bundle mount failed unexpectedly.', error);
  });
}

/**
 * The IAP products come from the catalog (`platformProductIds.ait`) at build
 * time, so the wrapper and the game agree on every SKU. The host bridge still
 * sells nothing until the game supplies its server hooks (`prepareIap`,
 * `verifyIapProductGrant`, `readIapEntitlements`, see the mpgd-kit
 * APPS_IN_TOSS_PRODUCTION_EVIDENCE guide): without them every purchase and
 * every `commerce.v2.*` method fails closed, and the grant callback only ever
 * confirms through the game backend.
 */
function iapBridgeOptions(): Pick<
  InstallAitHostBridgeOptions,
  'iapProducts' | 'prepareIap' | 'verifyIapProductGrant' | 'readIapEntitlements'
> {
  return runtimeConfig.iapProducts.length === 0 ? {} : { iapProducts: runtimeConfig.iapProducts };
}

function identityBridgeOptions(): Pick<InstallAitHostBridgeOptions, 'dependencies'> {
  return import.meta.env.VITE_MPGD_AIT_MOCK_IDENTITY === '1'
    ? {
        dependencies: {
          identityProvider: async () => ({ type: 'HASH', hash: 'ait-local-player' }),
        },
      }
    : {};
}
