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
  ...notificationBridgeOptions(),
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
 * `verifyIapProductGrant`, see the mpgd-kit APPS_IN_TOSS_PRODUCTION_EVIDENCE
 * guide): without them every purchase and every `commerce.v2.*` method fails
 * closed, and the grant callback only ever confirms through the game backend.
 * Ownership is read from the backend ledger, not from the wrapper.
 */
function iapBridgeOptions(): Pick<
  InstallAitHostBridgeOptions,
  'iapProducts' | 'prepareIap' | 'verifyIapProductGrant'
> {
  return runtimeConfig.iapProducts.length === 0 ? {} : { iapProducts: runtimeConfig.iapProducts };
}

/**
 * Notifications v2 topics come from the notification topic catalog's
 * `targets.ait` mappings at build time. Without one the host bridge offers no
 * notifications event channel, so the game exposes no `notificationsV2`; with
 * them the bridge asks for each topic's agreement through
 * `Notification.requestAgreement` and routes notification landings. Agreements
 * are recorded by the game backend, never trusted from the wrapper.
 */
function notificationBridgeOptions(): Pick<InstallAitHostBridgeOptions, 'notificationTopics'> {
  return Object.keys(runtimeConfig.notificationTopics).length === 0
    ? {}
    : { notificationTopics: runtimeConfig.notificationTopics };
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
