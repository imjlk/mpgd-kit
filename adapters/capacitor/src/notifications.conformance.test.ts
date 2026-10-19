import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { NotificationProvider } from '@mpgd/platform/notifications';
import {
  runNotificationConformanceVectors,
  type NotificationConformanceContext,
  type NotificationConformanceHarness,
  type NotificationConformanceVectorResult,
} from '@mpgd/platform/notifications-conformance';
import {
  assertNotificationConformanceVector,
  type NotificationConformanceVector,
} from '@mpgd/platform/notifications-vectors';

import { createFakeNotificationSdks } from '../test/notifications-sdk-fixture.js';
import { createCapacitorPlatformGateway } from './index.js';
import { createNotificationServiceProvider } from './notifications-bridge.js';
import { createCapacitorNotificationProvider } from './notifications-provider.js';

const vectorsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'specs',
  'notifications',
  'vectors',
);
const vectors: readonly NotificationConformanceVector[] = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertNotificationConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  ));

interface Profile {
  readonly platform: 'android' | 'ios';
  readonly push?: boolean;
  readonly local?: boolean;
  /** Serve the provider through the gateway's `notificationsV2`, over the in-process bridge. */
  readonly gateway?: boolean;
}

const unusedBridge = {
  async request(input: BridgeRequest): Promise<BridgeResponse> {
    throw new Error(`The base bridge must not receive ${input.method}.`);
  },
};

/**
 * Runs the vectors against the Capacitor provider over the fake plugins. A
 * restart creates a new provider over the same fakes, as a new process
 * would: native listeners and the buffer go, the OS state stays.
 */
function harnessFor(profile: Profile) {
  return (context: NotificationConformanceContext): NotificationConformanceHarness => {
    const sdks = createFakeNotificationSdks({
      platform: profile.platform,
      ...(profile.push === undefined ? {} : { push: profile.push }),
      ...(profile.local === undefined ? {} : { local: profile.local }),
      now: () => context.clock.now(),
    });
    const create = (): NotificationProvider => {
      const native = createCapacitorNotificationProvider({
        platform: profile.platform,
        topics: context.catalog,
        ...(sdks.push === undefined ? {} : { push: sdks.push }),
        ...(sdks.local === undefined ? {} : { local: sdks.local }),
        app: sdks.app,
        openSettings: async () => {
          sdks.app.setActive(false);
          queueMicrotask(() => sdks.app.setActive(true));
        },
        timeZone: () => context.timeZone,
        locale: () => undefined,
        onError: (error) => {
          throw error;
        },
      });
      if (profile.gateway !== true) {
        return native;
      }
      const gateway = createCapacitorPlatformGateway({
        target: profile.platform,
        appVersion: '1.0.0',
        buildId: 'conformance',
        bridge: unusedBridge,
        providers: [
          createNotificationServiceProvider({
            id: 'notifications',
            notifications: native,
            topics: context.catalog,
          }),
        ],
      });
      if (gateway.notificationsV2 === undefined) {
        throw new Error('The gateway did not expose notificationsV2.');
      }
      return gateway.notificationsV2;
    };
    let current = create();
    const provider: NotificationProvider = {
      get provider() {
        return current.provider;
      },
      getCapabilities: () => current.getCapabilities(),
      getPermission: (input) => current.getPermission(input),
      requestPermission: (input) => current.requestPermission(input),
      ...(current.register === undefined ? {} : { register: () => current.register!() }),
      ...(current.scheduleLocal === undefined
        ? {}
        : {
            scheduleLocal: (input) => current.scheduleLocal!(input),
            cancelLocal: (input) => current.cancelLocal!(input),
            listLocal: () => current.listLocal!(),
          }),
      ...(current.openSettings === undefined ? {} : { openSettings: () => current.openSettings!() }),
      subscribe: (listener) => current.subscribe(listener),
    };
    return {
      provider,
      host: {
        queuePrompt: (result) => sdks.queuePrompt(result),
        setPermission: (state) => sdks.setPermission(state),
        issueEndpoint: (endpoint) => sdks.issueEndpoint(endpoint),
        completeAction: () => sdks.completeAction(),
        tap: (tap) => sdks.tap(tap),
        get prompts() {
          return sdks.prompts;
        },
        get localOperations() {
          return sdks.localOperations;
        },
        get localPending() {
          return sdks.localPending;
        },
        restart() {
          sdks.restart();
          current = create();
        },
      },
    };
  };
}

function summary(results: readonly NotificationConformanceVectorResult[]) {
  return {
    failed: results.filter((result) => result.status === 'failed')
      .map(({ vector, failures }) => ({ vector, failures })),
    passed: results.filter((result) => result.status === 'passed').map(({ vector }) => vector),
  };
}

describe('Capacitor notifications provider conformance', () => {
  it.each([
    { name: 'Android', profile: { platform: 'android' } },
    { name: 'Android through the gateway', profile: { platform: 'android', gateway: true } },
    { name: 'iOS', profile: { platform: 'ios' } },
    { name: 'iOS through the gateway', profile: { platform: 'ios', gateway: true } },
  ] as const)('passes every applicable vector on $name', async ({ profile }) => {
    const results = await runNotificationConformanceVectors(vectors, {
      createProvider: harnessFor(profile),
    });
    const { failed, passed } = summary(results);
    expect(failed).toEqual([]);
    const expected = [
      'advertising-needs-consent',
      'advertising-night-window',
      'advertising-notice-variants',
      'advertising-notices',
      'advertising-rules-none',
      'advertising-sender-required',
      'endpoint-fan-out',
      'endpoint-lifecycle',
      'endpoint-rotation',
      'endpoint-unbind-on-logout',
      'endpoint-unbind-on-session-end',
      'idempotency-key-reuse',
      ...(profile.platform === 'ios' ? ['local-capacity-keeps-nearest'] : []),
      'local-only-topic',
      'local-reminder-cancelled-on-withdrawal',
      'local-schedule-never-prompts',
      'open-before-listener',
      profile.platform === 'android' ? 'os-permission-denied-twice' : 'os-permission-denied-once',
      ...(profile.platform === 'android' ? ['os-permission-dismissed'] : []),
      'os-permission-granted',
      'os-permission-revoked-in-settings',
      'provider-rate-limited',
      'reminder-cancel-across-routes',
      'reminder-local-quiet-hours',
      'reminder-local-route',
      'reminder-server-deferred-cancel',
      'reminder-server-set-checks',
      'requested-topic-needs-opt-in',
    ];
    expect(passed).toEqual([...expected].sort());
  });

  it('runs only the vectors a provider without push can pass', async () => {
    // Without the push plugin no push can be tapped.
    const local = vectors.filter((vector) => !vector.steps.some((step) =>
      step.actor === 'host' && step.action === 'tap' && step.input.channel === 'remote'));
    const results = await runNotificationConformanceVectors(local, {
      createProvider: harnessFor({ platform: 'android', push: false }),
    });
    const { failed, passed } = summary(results);
    expect(failed).toEqual([]);
    expect(passed).toEqual([
      'local-reminder-cancelled-on-withdrawal',
      'local-schedule-never-prompts',
      'reminder-local-quiet-hours',
      'reminder-local-route',
    ]);
  });

  it('answers the unsupported vector when neither plugin is installed', async () => {
    const results = await runNotificationConformanceVectors(vectors, {
      createProvider: harnessFor({ platform: 'ios', push: false, local: false, gateway: true }),
    });
    const { failed, passed } = summary(results);
    expect(failed).toEqual([]);
    expect(passed).toEqual(['unsupported-target']);
  });
});
