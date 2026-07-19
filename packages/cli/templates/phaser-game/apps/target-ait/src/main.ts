import './styles.css';

import { installAitHostBridge, type InstallAitHostBridgeOptions } from '@mpgd/adapter-ait/host';
import { mountAitGameBundle } from '@mpgd/adapter-ait/wrapper';

declare const __MPGD_AIT_APP_NAME__: string;
declare const __MPGD_AIT_AD_GROUP_IDS__: Readonly<Record<string, string>>;
declare const __MPGD_AIT_AD_PLACEMENT_TYPES__: Readonly<
  Record<string, 'rewarded' | 'interstitial'>
>;

installAitHostBridge({
  appName: __MPGD_AIT_APP_NAME__,
  adGroupIds: __MPGD_AIT_AD_GROUP_IDS__,
  adPlacementTypes: __MPGD_AIT_AD_PLACEMENT_TYPES__,
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
