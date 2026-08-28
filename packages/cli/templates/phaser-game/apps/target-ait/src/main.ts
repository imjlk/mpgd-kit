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
  ...identityBridgeOptions(),
});

const app = document.querySelector<HTMLElement>('#app');
if (app !== null) {
  void mountAitGameBundle(app).catch((error: unknown) => {
    console.error('AIT game bundle mount failed unexpectedly.', error);
  });
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
