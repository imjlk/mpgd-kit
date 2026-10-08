import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AdResult } from '@verse8/ads';
import { createGameExecutionController, type ExecutionBlock } from '@mpgd/game-runtime';
import { createFullScreenPresentationScope } from '@mpgd/game-runtime/presentation';
import { createCoordinatedPlatformGateway } from '@mpgd/game-runtime/ads';
import { createAdSession, reduceAdSession, type AdSessionSnapshot } from '@mpgd/platform/ads';
import {
  runAdConformance,
  type AdConformanceFixture,
  type AdConformanceValue,
} from '@mpgd/platform/ads-conformance';
import {
  createVerse8PlatformGateway,
  type Verse8AdPresentationEvent,
  type Verse8AdsClient,
} from './index.js';

// These vectors exercise presentation, not the independent server grant port.
const names = [
  'configuration-required',
  'policy-disabled',
  'preparation-deferred',
  'timeout-late-close',
  'full-screen-arbitration',
  'background-ownership',
  'interstitial-shown',
  'show-failure',
] as const;
const vectors = names.map(
  (name) => JSON.parse(readFileSync(new URL(`../../../docs/specs/ads/vectors/${name}.json`, import.meta.url), 'utf8')) as unknown,
);
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve();
  }
}
const fixture: AdConformanceFixture = {
  name: 'verse8-sdk-host-presentation',
  async create({ profile }) {
    const nativeListeners = new Set<(event: Verse8AdPresentationEvent) => void>();
    const requests = new Map<string, (result: AdResult) => void>();
    let sdkShows = 0;
    const show = (input: Parameters<Verse8AdsClient['showRewarded']>[0]) => {
      sdkShows += 1;
      return new Promise<AdResult>((resolve) => { requests.set(input.requestId ?? '', resolve); });
    };
    const client: Verse8AdsClient = { showRewarded: show, showInterstitial: async (input) => { const result = await show(input); if (result.status === 'rewarded') { throw new Error('Interstitial cannot earn a reward.'); } return result; } };
    const original = createVerse8PlatformGateway({ adsClient: client,
      ...(profile.configured === true ? { resolveAdPlacementId: () => 'native-placement' } : {}),
      adPresentation: { subscribe(listener) { nativeListeners.add(listener); return () => { nativeListeners.delete(listener); }; } },
    });
    const source = original.ads.provider;
    if (source === undefined) { throw new Error('Verse8 provider missing.'); }
    const execution = createGameExecutionController();
    const presentation = createFullScreenPresentationScope({ execution });
    const gateway = createCoordinatedPlatformGateway({ gateway: original, provider: source, presentation, canShow: () => profile.policyEnabled !== false,
      deadline: { milliseconds: 30000, schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } },
    });
    const ads = gateway.ads.provider;
    if (ads === undefined) { throw new Error('Coordinated Verse8 provider missing.'); }
    const sessions = new Map<string, AdSessionSnapshot>();
    const outcomes = new Map<string, string>();
    const reasons = new Map<string, string>();
    const sequences = new Map<string, number>();
    const blocks = new Map<string, ExecutionBlock>();
    let last = '';
    let preparation = '';
    let lateCloseObserved = false;
    const emit = (requestId: string, state: Verse8AdPresentationEvent['state']) => {
      const sequence = (sequences.get(requestId) ?? 0) + 1;
      sequences.set(requestId, sequence);
      for (const listener of [...nativeListeners]) { listener({ requestId, sequence, state }); }
    };
    ads.subscribe((event) => {
      const previous = sessions.get(event.invocationId);
      if (previous === undefined) { throw new Error('Event without original invocation.'); }
      if (event.type === 'closed' && previous.presentation === 'unknown') { lateCloseObserved = true; }
      sessions.set(event.invocationId, reduceAdSession(previous, event));
    });
    return {
      async step(step) {
        if (step.actor === 'game') {
          if (step.action === 'prepare') { preparation = (await ads.preload({ placementId: String(step.placementId), format: 'rewarded' })).status; } else if (step.action === 'start') {
            const id = String(step.invocationId);
            last = id;
            if (step.format === 'purchase') {
              void gateway.commerce.purchase({ productId: String(step.placementId), source: 'shop', idempotencyKey: id }).then(() => { throw new Error('Purchase reached SDK during another presentation.'); }, (error: unknown) => {
                if (!(error instanceof Error) || !('code' in error)) { throw error; }
                outcomes.set(id, 'unavailable');
                reasons.set(id, String(error.code));
              });
            } else {
              const format = step.format === 'interstitial' ? 'interstitial' : 'rewarded';
              sessions.set(id, createAdSession({ providerId: ads.id, invocationId: id, format, rewardSignal: ads.rewardSignal }));
              void ads.show({ placementId: String(step.placementId), invocationId: id, idempotencyKey: id, format }).then((result) => { outcomes.set(id, result.outcome); if (result.reason !== undefined) { reasons.set(id, result.reason); } });
            }
          } else { throw new Error('Disposal recovery requires a ledger fixture.'); }
        } else if (step.actor === 'sdk') {
          const id = String(step.invocationId);
          if (!requests.has(id)) { throw new Error('SDK event without original request.'); }
          if (step.action === 'started') { emit(id, 'open'); } else if (step.action === 'closed') { emit(id, 'closed'); } else if (step.action === 'rewardEarned') { requests.get(id)?.({ status: 'rewarded', requestId: id }); } else { emit(id, 'not-started'); }
        } else if (step.actor === 'clock') { await vi.advanceTimersByTimeAsync(Number(step.milliseconds)); } else if (step.actor === 'runtime') {
          const owner = String(step.owner);
          if (step.action === 'block') { blocks.set(owner, execution.acquireBlock({ reason: owner, channels: ['simulation', 'gameplay-input', 'audio'] })); } else if (step.action === 'release') { blocks.get(owner)?.release(); blocks.delete(owner); } else { throw new Error('Journal recovery requires a ledger fixture.'); }
        } else { throw new Error('This fixture cannot verify or grant rewards.'); }
        await flush();
      },
      async read(): Promise<Readonly<Record<string, AdConformanceValue>>> {
        const owner = presentation.getSnapshot().owner;
        const session = sessions.get(last);
        return { sdkShows, purchaseUiOpened: 0, ledgerGrants: 0, occupied: owner !== undefined, outcomes: Object.fromEntries(outcomes), reasons: Object.fromEntries(reasons), reason: reasons.get(last) ?? session?.reason ?? '', preparation, lateCloseObserved,
          presentation: session?.presentation ?? 'not-started', eligibility: session?.eligibility ?? 'unknown', activeInvocationId: owner?.invocationId ?? '',
          executionOwners: execution.getSnapshot().blocks.map((block) => block.reason.startsWith('presentation:') ? `ad:${owner?.invocationId}` : block.reason),
        };
      },
      async dispose() {
        for (const [id, resolve] of requests) { emit(id, 'closed'); resolve({ status: 'failed', requestId: id, error: { code: 'timeout' } }); }
        await flush();
        gateway.dispose();
        presentation.dispose();
        for (const block of blocks.values()) { block.release(); }
        vi.clearAllTimers();
      },
    };
  },
};
describe('actual Verse8 SDK provider and scoped host presentation vectors', () => {
  it('passes eight applicable vectors through the real adapter and common runtime', async () => {
    vi.useFakeTimers();
    try {
      const result = await runAdConformance({ vectors, fixtures: [fixture] });
      expect(result.passed.map((entry) => entry.vector)).toEqual(names);
    } finally {
      vi.useRealTimers();
    }
  });
});
