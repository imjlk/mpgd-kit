import assert from 'node:assert/strict';

import {
  adProtocol, adProtocolVersion, createAdSession, reduceAdSession, toAdAdapter,
} from '@mpgd/platform/ads';
import { runAdConformance } from '@mpgd/platform/ads-conformance';

const initial = createAdSession({ providerId: 'packed-fixture', invocationId: 'a', format: 'rewarded' });
const unknown = reduceAdSession(initial, {
  providerId: 'packed-fixture', invocationId: 'a', sequence: 1, type: 'unknown',
});
assert.equal(unknown.presentation, 'unknown');
const closed = reduceAdSession(unknown, {
  providerId: 'packed-fixture', invocationId: 'a', sequence: 2, type: 'closed',
});
assert.equal(closed.presentation, 'closed');

const evidence = { schema: 'packed.reward.v1', payload: { impressionId: 'a' } };
const facade = toAdAdapter({
  id: 'packed-fixture', protocol: adProtocol, protocolVersion: adProtocolVersion,
  rewardSignal: 'immediate',
  async getAvailability() { return { state: 'available' }; },
  async preload() { return { status: 'deferred' }; },
  async show(input) {
    return {
      providerId: 'packed-fixture', invocationId: input.invocationId, format: 'rewarded',
      outcome: 'shown', presentation: 'closed', eligibility: 'eligible', evidence,
    };
  },
  subscribe() { return () => {}; },
});
const result = await facade.showRewarded({ placementId: 'CONTINUE', idempotencyKey: 'a' });
assert.equal(result.rewardGranted, false);
assert.equal(result.status, 'completed');
assert.equal(result.ledgerEntryId, undefined);
assert.deepEqual(result.evidence, evidence);

let cleaned = false;
const report = await runAdConformance({
  vectors: [{
    vector: 'packed-negative', protocol: adProtocol, version: adProtocolVersion,
    profile: { formats: [], configured: true, rewardSignal: 'immediate' },
    steps: [{ actor: 'game', action: 'start', invocationId: 'a', format: 'rewarded', placementId: 'CONTINUE' }],
    expect: { sdkShows: 0 },
  }],
  fixtures: [{
    name: 'packed-driver',
    async create() {
      let shows = 0;
      return {
        async step(step) { if (step.actor === 'sdk') shows += 1; },
        async read() { return { sdkShows: shows }; },
        async dispose() { cleaned = true; },
      };
    },
  }],
});
assert.equal(report.passed.length, 1);
assert.equal(cleaned, true);
console.info('Advertising contract and conformance dist entrypoints passed.');
