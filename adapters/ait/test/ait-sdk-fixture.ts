import { vi, type Mock } from 'vitest';
import { createGameExecutionController } from '@mpgd/game-runtime';
import { createFullScreenPresentationScope } from '@mpgd/game-runtime/presentation';
import {
  createCoordinatedPlatformGateway,
  type AdClaimEvidenceObservation,
} from '@mpgd/game-runtime/ads';
import type { AdPresentationEvent, AdShowInput } from '@mpgd/platform/ads';
import { createAitHostBridge, type AitHostDependencies } from '../src/host.js';
import { createAitPlatformGateway } from '../src/index.js';

type ShowCallbacks = Parameters<AitHostDependencies['showFullScreenAd']>[0];
export async function flush(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve();
  }
}
export function fixture(options: { configured?: boolean; supported?: boolean; canShow?: () => boolean; deadlineMs?: number } = {}) {
  const callbacks: ShowCallbacks[] = [];
  const cleanups: Mock<() => void>[] = [];
  const show: Mock<(callback: ShowCallbacks) => () => void> & { isSupported(): boolean } = Object.assign(
    vi.fn((callback: ShowCallbacks) => {
      callbacks.push(callback);
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      return cleanup;
    }),
    { isSupported: () => options.supported !== false },
  );
  const load: Mock<(callback: Parameters<AitHostDependencies['loadFullScreenAd']>[0]) => () => void> & { isSupported(): boolean } = Object.assign(
    vi.fn((callback: Parameters<AitHostDependencies['loadFullScreenAd']>[0]) => {
      queueMicrotask(() => callback.onEvent({ type: 'loaded' }));
      return () => {};
    }),
    { isSupported: () => options.supported !== false },
  );
  const host = () => createAitHostBridge({
    adGroupIds: options.configured === false
      ? {}
      : { CONTINUE: 'reward-group', BREAK: 'interstitial-group' },
    adPlacementTypes: { CONTINUE: 'rewarded', BREAK: 'interstitial' },
    adTimeoutMs: 50,
    adMaximumDisplayMs: 100,
    dependencies: { showFullScreenAd: show, loadFullScreenAd: load },
  });
  const bridge = host();
  const original = createAitPlatformGateway({ appVersion: 'test', buildId: 'test', bridge });
  const source = original.ads.provider;
  if (source === undefined) {
    throw new Error('Host did not expose its advertising provider.');
  }
  const execution = createGameExecutionController();
  const presentation = createFullScreenPresentationScope({ execution });
  const evidence: AdClaimEvidenceObservation[] = [];
  const gateway = createCoordinatedPlatformGateway({
    gateway: original,
    provider: source,
    presentation,
    ...(options.canShow === undefined ? {} : { canShow: options.canShow }),
    onClaimEvidence: (entry) => {
      evidence.push(entry);
    },
    deadline: {
      milliseconds: options.deadlineMs ?? 30,
      schedule(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
  const ads = gateway.ads.provider;
  if (ads === undefined) {
    throw new Error('Coordinated provider missing.');
  }
  const events: AdPresentationEvent[] = [];
  ads.subscribe((event) => {
    events.push(event);
  });
  const input: AdShowInput = {
    placementId: 'CONTINUE',
    format: 'rewarded',
    invocationId: 'invocation-a',
    idempotencyKey: 'claim-a',
  };
  return {
    ads,
    source,
    host,
    show,
    load,
    callbacks,
    cleanups,
    execution,
    presentation,
    gateway,
    evidence,
    events,
    input,
  };
}
