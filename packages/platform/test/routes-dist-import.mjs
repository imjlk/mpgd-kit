import assert from 'node:assert/strict';

import { rootRelativeRouteVectors } from '@mpgd/platform/route-vectors';
import {
  hasNetworkPathPrefix,
  hasRouteControlCharacter,
  isHostedGameServicesPath,
  normalizeRootRelativeRoute,
} from '@mpgd/platform/routes';

for (const [input, route] of rootRelativeRouteVectors.normalized) {
  assert.equal(normalizeRootRelativeRoute(input), route, input);
}

for (const input of rootRelativeRouteVectors.rejected) {
  assert.equal(normalizeRootRelativeRoute(input), undefined, JSON.stringify(input));
}

assert.equal(hasNetworkPathPrefix('/%2F/evil.example'), true);
assert.equal(hasRouteControlCharacter('/a\u0000'), true);
assert.equal(isHostedGameServicesPath('/api/game-services'), true);
assert.equal(isHostedGameServicesPath('//evil.example/api'), false);
