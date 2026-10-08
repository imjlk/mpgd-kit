import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBlock } from '@mpgd/game-runtime';
import { createAdSession, reduceAdSession, type AdSessionSnapshot } from '@mpgd/platform/ads';
import {
  runAdConformance,
  type AdConformanceFixture,
  type AdConformanceValue,
} from '@mpgd/platform/ads-conformance';
import { fixture, flush } from '../test/ait-sdk-fixture.js';

// Presentation only: ledger vectors require an independently verified backend.
const names = [
  'unsupported',
  'configuration-required',
  'policy-disabled',
  'preparation-ready',
  'timeout-late-close',
  'full-screen-arbitration',
  'background-ownership',
] as const;
const vectors = names.map(
  (name) => JSON.parse(readFileSync(new URL(`../../../docs/specs/ads/vectors/${name}.json`, import.meta.url), 'utf8')) as unknown,
);
const nativeFixture: AdConformanceFixture = {
  name: 'ait-native-host-proxy-presentation',
  async create({ profile }) {
    const f = fixture({ configured: profile.configured === true, supported: Array.isArray(profile.formats) && profile.formats.length > 0, canShow: () => profile.policyEnabled !== false, deadlineMs: 30000 });
    const sessions = new Map<string, AdSessionSnapshot>();
    const callbacks = new Map<string, (typeof f.callbacks)[number]>();
    const outcomes = new Map<string, string>();
    const reasons = new Map<string, string>();
    const blocks = new Map<string, ExecutionBlock>();
    let last = '';
    let preparation = '';
    let lateCloseObserved = false;
    f.ads.subscribe((event) => {
      const previous = sessions.get(event.invocationId);
      if (previous === undefined) { throw new Error('SDK callback without a game invocation.'); }
      if (event.type === 'closed' && previous.presentation === 'unknown') { lateCloseObserved = true; }
      sessions.set(event.invocationId, reduceAdSession(previous, event));
    });
    return {
      async step(step) {
        if (step.actor === 'game') {
          if (step.action === 'prepare') { preparation = (await f.ads.preload({ placementId: String(step.placementId), format: 'rewarded' })).status; } else if (step.action === 'start') {
            const id = String(step.invocationId);
            last = id;
            if (step.format === 'purchase') {
              void f.gateway.commerce.purchase({ productId: String(step.placementId), source: 'shop', idempotencyKey: id }).then(() => { throw new Error('Purchase must be blocked before the SDK.'); }, (error: unknown) => {
                if (!(error instanceof Error) || !('code' in error)) { throw error; }
                outcomes.set(id, 'unavailable');
                reasons.set(id, String(error.code));
              });
            } else {
              const format = step.format === 'interstitial' ? 'interstitial' : 'rewarded';
              sessions.set(id, createAdSession({ providerId: f.ads.id, invocationId: id, format, rewardSignal: f.ads.rewardSignal }));
              const count = f.callbacks.length;
              void f.ads.show({ placementId: String(step.placementId), format, invocationId: id, idempotencyKey: id }).then((result) => { outcomes.set(id, result.outcome); if (result.reason !== undefined) { reasons.set(id, result.reason); } });
              await flush();
              if (f.callbacks.length > count) { const callback = f.callbacks.at(-1); if (callback !== undefined) { callbacks.set(id, callback); } }
            }
          } else { throw new Error('View disposal requires the separate recovery fixture.'); }
        } else if (step.actor === 'sdk') {
          const callback = callbacks.get(String(step.invocationId));
          if (callback === undefined) { throw new Error('SDK event without a native invocation callback.'); }
          if (step.action === 'started') { callback.onEvent({ type: 'show' }); } else if (step.action === 'closed') { callback.onEvent({ type: 'dismissed' }); } else if (step.action === 'rewardEarned') { callback.onEvent({ type: 'userEarnedReward', data: { unitType: 'coin', unitAmount: 1 } }); } else { callback.onEvent({ type: 'failedToShow' }); }
        } else if (step.actor === 'clock') { await vi.advanceTimersByTimeAsync(Number(step.milliseconds)); } else if (step.actor === 'runtime') {
          const owner = String(step.owner);
          if (step.action === 'block') { blocks.set(owner, f.execution.acquireBlock({ reason: owner, channels: ['simulation', 'gameplay-input', 'audio'] })); } else if (step.action === 'release') { blocks.get(owner)?.release(); blocks.delete(owner); } else { throw new Error('Recovery requires the separate ledger fixture.'); }
        } else { throw new Error('This fixture has no backend verification or grant port.'); }
        await flush();
      },
      async read(): Promise<Readonly<Record<string, AdConformanceValue>>> {
        const owner = f.presentation.getSnapshot().owner;
        const session = sessions.get(last);
        return { sdkShows: f.show.mock.calls.length, purchaseUiOpened: 0, ledgerGrants: 0, occupied: owner !== undefined,
          outcomes: Object.fromEntries(outcomes), reasons: Object.fromEntries(reasons), reason: reasons.get(last) ?? session?.reason ?? '', preparation, lateCloseObserved,
          presentation: session?.presentation ?? 'not-started', eligibility: session?.eligibility ?? 'unknown', activeInvocationId: owner?.invocationId ?? '',
          executionOwners: f.execution.getSnapshot().blocks.map((block) => block.reason.startsWith('presentation:') ? `ad:${owner?.invocationId}` : block.reason),
        };
      },
      async dispose() {
        for (const callback of callbacks.values()) { callback.onEvent({ type: 'failedToShow' }); }
        await flush();
        f.gateway.dispose();
        f.presentation.dispose();
        for (const block of blocks.values()) { block.release(); }
        vi.clearAllTimers();
      },
    };
  },
};
describe('actual AIT SDK host/proxy presentation vectors', () => {
  it('passes seven applicable shared vectors without provider-name branches in the runtime', async () => {
    vi.useFakeTimers();
    try {
      const result = await runAdConformance({ vectors, fixtures: [nativeFixture] });
      expect(result.passed.map((entry) => entry.vector)).toEqual(names);
    } finally {
      vi.useRealTimers();
    }
  });
});
