import { readFileSync } from 'node:fs';
import { RewardAdPluginEvents } from '@capacitor-community/admob';
import { describe, expect, it, vi } from 'vitest';
import { createGameExecutionController, type ExecutionBlock } from '@mpgd/game-runtime';
import { createFullScreenPresentationScope } from '@mpgd/game-runtime/presentation';
import { createCoordinatedPlatformGateway } from '@mpgd/game-runtime/ads';
import { createAdSession, reduceAdSession, type AdSessionSnapshot } from '@mpgd/platform/ads';
import {
  runAdConformance,
  type AdConformanceFixture,
  type AdConformanceValue,
} from '@mpgd/platform/ads-conformance';

import { createCapacitorAdMobRewardedProvider } from './admob.js';
import { createCapacitorPlatformGateway } from './index.js';
import { createAdMobSdkFixture } from '../test/admob-sdk-fixture.js';
import { decodeAdMobSsvCustomData } from '@mpgd/game-services/admob-ssv';

// This subset certifies native presentation only. Server-ledger vectors need a
// separate fixture; rewarded-only/deferred AdMob cannot emulate interstitials.
const presentationVectors = [
  'action-required',
  'configuration-required',
  'policy-disabled',
  'preparation-deferred',
  'timeout-late-close',
  'full-screen-arbitration',
  'background-ownership',
] as const;
const vectors = presentationVectors.map(
  (name) => JSON.parse(readFileSync(new URL(`../../../docs/specs/ads/vectors/${name}.json`, import.meta.url), 'utf8')) as unknown,
);
const unit = 'ca-app-pub-1234567890123456/1234567890';
async function flush(): Promise<void> {
  for (let i = 0; i < 128; i += 1) {
    await Promise.resolve();
  }
}

const fixture: AdConformanceFixture = {
  name: 'capacitor-admob-native-presentation',
  async create({ profile }) {
    const sdk = createAdMobSdkFixture();
    const earnedPromises = new Map<string, (value: { type: string; amount: number }) => void>();
    sdk.show.mockImplementation(() => new Promise((resolve) => {
      const options = sdk.prepare.mock.calls.at(-1)?.[0] as { ssv: { customData: string } };
      const binding = decodeAdMobSsvCustomData(options.ssv.customData);
      if (binding === undefined) { throw new Error('Native SDK show lacks a valid SSV binding.'); }
      earnedPromises.set(binding.idempotencyKey, resolve);
    }));
    const provider = createCapacitorAdMobRewardedProvider({ sdk: sdk.sdk, target: 'android', adUnits: profile.configured === true ? { CONTINUE: unit } : { OTHER: unit }, getPlayerId: () => 'test-player' });
    if (profile.actionRequired !== true) { await provider.requestConsent(); }
    const execution = createGameExecutionController();
    const presentation = createFullScreenPresentationScope({ execution });
    const observerErrors: unknown[] = [];
    let purchaseUiOpened = 0;
    const original = createCapacitorPlatformGateway({
      target: 'android', appVersion: 'test', buildId: 'test', providers: [provider], visibility: null,
      app: { addListener: async () => ({ remove: async () => {} }), getState: async () => ({ isActive: true }), getLaunchUrl: async () => undefined, exitApp: async () => {} },
      bridge: { async request(request) { purchaseUiOpened += 1; return { id: request.id, ok: true, data: { status: 'cancelled', entitlementIds: [] } }; } },
    });
    const gateway = createCoordinatedPlatformGateway({ gateway: original, provider: provider.adProvider, presentation, onObserverError: (error) => { observerErrors.push(error); }, canShow: () => profile.policyEnabled !== false, deadline: { milliseconds: 30000, schedule(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } } });
    const ads = gateway.ads.provider;
    if (ads === undefined) { throw new Error('Installed AdMob event surface is missing.'); }
    const sessions = new Map<string, AdSessionSnapshot>();
    const outcomes = new Map<string, string>();
    const reasons = new Map<string, string>();
    const blocks = new Map<string, ExecutionBlock>();
    let last = '';
    let preparation = '';
    let lateCloseObserved = false;
    ads.subscribe((event) => {
      const previous = sessions.get(event.invocationId);
      if (previous === undefined) { throw new Error('SDK event without an original game invocation.'); }
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
              void gateway.commerce.purchase({ productId: String(step.placementId), source: 'shop', idempotencyKey: id }).then(() => { outcomes.set(id, 'shown'); }, (error: unknown) => {
                if (!(error instanceof Error) || !('code' in error)) { throw error; }
                outcomes.set(id, 'unavailable');
                reasons.set(id, String(error.code));
              });
            } else {
              const format = step.format === 'interstitial' ? 'interstitial' : 'rewarded';
              sessions.set(id, createAdSession({ providerId: ads.id, invocationId: id, format, rewardSignal: ads.rewardSignal }));
              void ads.show({ placementId: String(step.placementId), invocationId: id, idempotencyKey: id, format }).then((result) => { outcomes.set(id, result.outcome); if (result.reason !== undefined) { reasons.set(id, result.reason); } });
            }
          } else { throw new Error('View disposal is outside this presentation-only fixture.'); }
        } else if (step.actor === 'sdk') {
          if (presentation.getSnapshot().owner?.invocationId !== step.invocationId) { throw new Error('Native global callback does not identify the requested invocation.'); }
          if (step.action === 'started') { sdk.emit(RewardAdPluginEvents.Showed); } else if (step.action === 'closed') { sdk.emit(RewardAdPluginEvents.Dismissed); } else if (step.action === 'rewardEarned') {
            const resolve = earnedPromises.get(String(step.invocationId));
            if (resolve === undefined) { throw new Error('Reward without a native show promise.'); }
            resolve({ type: 'coin', amount: 1 });
          } else { sdk.emit(RewardAdPluginEvents.FailedToShow); }
        } else if (step.actor === 'clock') { await vi.advanceTimersByTimeAsync(Number(step.milliseconds)); } else if (step.actor === 'runtime') {
          const owner = String(step.owner);
          if (step.action === 'block') { blocks.set(owner, execution.acquireBlock({ reason: owner, channels: ['simulation', 'gameplay-input', 'audio'] })); } else if (step.action === 'release') { blocks.get(owner)?.release(); blocks.delete(owner); } else { throw new Error('Financial recovery is outside this presentation-only fixture.'); }
        } else { throw new Error('No backend claim or grant port is installed in this presentation fixture.'); }
        await flush();
        if (observerErrors.length > 0) { throw observerErrors[0]; }
      },
      async read(): Promise<Readonly<Record<string, AdConformanceValue>>> {
        const owner = presentation.getSnapshot().owner;
        const session = sessions.get(last);
        return {
          sdkShows: sdk.show.mock.calls.length, purchaseUiOpened,
          // There is no ledger port here. This fixture cannot produce a grant.
          ledgerGrants: 0, occupied: owner !== undefined, outcomes: Object.fromEntries(outcomes), reasons: Object.fromEntries(reasons),
          reason: reasons.get(last) ?? session?.reason ?? '', preparation, lateCloseObserved,
          presentation: session?.presentation ?? 'not-started', eligibility: session?.eligibility ?? 'unknown', activeInvocationId: owner?.invocationId ?? '',
          executionOwners: execution.getSnapshot().blocks.map((block) => block.reason.startsWith('presentation:') ? `ad:${owner?.invocationId}` : block.reason),
        };
      },
      async dispose() {
        sdk.emit(RewardAdPluginEvents.Dismissed);
        await flush();
        gateway.dispose();
        presentation.dispose();
        for (const block of blocks.values()) { block.release(); }
        await original.lifecycle.dispose?.();
        vi.clearAllTimers();
      },
    };
  },
};

describe('actual AdMob provider and gateway presentation vectors', () => {
  it('drives the shared vector runner with fake native SDK callbacks through the real adapter', async () => {
    vi.useFakeTimers();
    try {
      const result = await runAdConformance({ vectors, fixtures: [fixture] });
      expect(result.passed.map((entry) => entry.vector)).toEqual(presentationVectors);
    } finally {
      vi.useRealTimers();
    }
  });
});
