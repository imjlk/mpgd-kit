import assert from 'node:assert/strict';

import { rootRelativeRouteVectors, shareLinkVectors } from '@mpgd/platform/route-vectors';
import {
  normalizeShareLink,
  readShareIntent,
  withShareIntentCheck,
} from '@mpgd/platform/routes';
import { runShareLinkConformance } from '@mpgd/platform/share-link-conformance';

for (const [input, link] of shareLinkVectors.normalized) {
  assert.equal(normalizeShareLink(input), link, input);
}

for (const input of shareLinkVectors.rejected) {
  assert.equal(normalizeShareLink(input), undefined, JSON.stringify(input));
}

assert.equal(readShareIntent(null), undefined);

const handed = [];
const sharing = withShareIntentCheck({
  async share(intent) {
    handed.push(intent.deepLink);
    return { status: 'shared', completion: 'presented' };
  },
});
const report = await runShareLinkConformance({
  name: 'dist',
  share: (intent) => sharing.share(intent),
  sharedResult: { status: 'shared', completion: 'presented' },
  host: {
    handedLinks: () => handed,
    expectedLink: (link) => link,
  },
});

assert.equal(
  report.shared,
  rootRelativeRouteVectors.normalized.length + shareLinkVectors.normalized.length,
);
