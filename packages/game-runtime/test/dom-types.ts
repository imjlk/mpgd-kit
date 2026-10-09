import type { PlatformGateway } from '@mpgd/platform';
import { createInlineBannerManager, mountInlineBanner } from '@mpgd/game-runtime/dom';

declare const gateway: PlatformGateway;
const input = {
  gameRoot: document.createElement('div'),
  ads: gateway.ads,
  enabled: true,
  placementId: 'FOOTER',
  surfaceId: 'footer-ad',
  label: 'Advertisement',
  layoutClassName: 'banner-layout',
  surfaceClassName: 'banner-surface',
  stateDataKey: 'bannerState',
};
const manager = createInlineBannerManager(input);
const release = manager.acquire({ onLayoutChange: () => {} });
release();
manager.destroy();
mountInlineBanner(input).destroy();
