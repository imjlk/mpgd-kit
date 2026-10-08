import assert from 'node:assert/strict';
import { createClientRewardEvidenceRegistry } from '@mpgd/game-services/client-reward-evidence';
import { createDefaultClientRewardEvidenceRegistry } from '@mpgd/game-services/default-client-reward-evidence';
assert.equal(createClientRewardEvidenceRegistry([]).recognizes('unknown'), false);
assert.equal(createDefaultClientRewardEvidenceRegistry().recognizes('verse8.ads.reward.v1'), true);
console.log('Registered reward evidence dist entrypoints passed.');
