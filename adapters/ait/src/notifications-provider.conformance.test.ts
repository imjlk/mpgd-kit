import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { NotificationProvider } from '@mpgd/platform/notifications';
import {
  NotificationConformanceScriptError,
  notificationConformanceSkipReason,
  runNotificationConformanceVectors,
  type NotificationConformanceContext,
  type NotificationConformanceHarness,
  type NotificationConformanceHostActor,
} from '@mpgd/platform/notifications-conformance';
import {
  assertNotificationConformanceVector,
  type NotificationConformanceVector,
} from '@mpgd/platform/notifications-vectors';

import { createFakeAitHostDependencies, createFakeAitIapHost } from '../test/ait-iap-fixture.js';
import {
  createFakeAitNotificationHost,
  type FakeAitNotificationHost,
} from '../test/ait-notification-fixture.js';
import { createAitHostBridge } from './host.js';
import { createAitPlatformGateway } from './index.js';
import {
  aitNotificationAgreementEvidenceSchema,
  createAitNotificationCapabilities,
  createAitNotificationProvider,
  type AitNotificationTopicMapping,
} from './notifications-provider.js';

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

/** The vectors the Apps in Toss provider passes; every other vector is skipped by its `appliesTo`. */
const aitVectors = [
  'advertising-unsupported-by-host',
  'duplicate-topics-once',
  'host-agreement-dismissed',
  'host-agreement-recorded',
  'host-agreement-rejected',
  'host-agreement-then-withdrawn',
  'host-gesture-and-terms',
  'host-service-topic-without-agreement',
  'landing-open-before-listener',
  'provider-ambiguous-replay',
  'provider-minute-limit',
  'provider-rejected',
  'reminder-server-route',
];

/** The landing a fake launch carries before a `tap`: an ordinary launch. */
const plainLaunchUrl = 'intoss://fixture-game/';

type Transport = 'direct' | 'bridge';

/** The catalog's Apps in Toss mappings, as a game passes them to the host bridge. */
function topicsOf(context: NotificationConformanceContext): Record<string, AitNotificationTopicMapping> {
  const topics: Record<string, AitNotificationTopicMapping> = {};
  for (const topic of context.catalog) {
    const templateSetCode = topic.mapping?.['templateSetCode'];
    const agreement = topic.mapping?.['agreement'];
    if (typeof templateSetCode === 'string' && (agreement === 'required' || agreement === 'none')) {
      topics[topic.id] = { templateSetCode, agreement };
    }
  }
  return topics;
}

/**
 * The Apps in Toss provider over a fake SDK, directly or through the host
 * bridge and the game gateway. A restart is a new mini-app process over the
 * same host: a new provider (and bridge) reads the launch URL again, and
 * the launch is an ordinary one unless a `tap` came before it.
 */
function createAitHarness(
  context: NotificationConformanceContext,
  transport: Transport,
): NotificationConformanceHarness {
  const fake = createFakeAitNotificationHost({ initialUrl: plainLaunchUrl });
  const topics = topicsOf(context);
  const build = (): NotificationProvider => {
    if (transport === 'direct') {
      return createAitNotificationProvider({
        sdk: fake.sdk,
        topics,
        agreementTimeoutMs: 5,
        timeZone: () => context.timeZone,
      });
    }
    const bridge = createAitHostBridge({
      notificationTopics: topics,
      notificationAgreementTimeoutMs: 5,
      dependencies: createFakeAitHostDependencies(createFakeAitIapHost({ products: [] }), {
        requestNotificationAgreement: fake.sdk.requestAgreement,
        readInitialUrl: fake.sdk.readInitialUrl,
      }),
    });
    const provider = createAitPlatformGateway({ appVersion: '1.0.0', buildId: 'test', bridge })
      .notificationsV2;
    if (provider !== undefined) {
      return provider;
    }
    if (
      Object.keys(topics).length > 0
      || notificationConformanceSkipReason(context.vector, createAitNotificationCapabilities())
        === undefined
    ) {
      // A vector the profile runs must go through the bridge.
      throw new Error('The Apps in Toss gateway did not expose notificationsV2.');
    }
    // A vector that maps no Apps in Toss topic: the host offers no channel, so
    // the gateway exposes nothing; the provider's own (configuration-required)
    // capabilities let the runner judge the vector's appliesTo.
    return createAitNotificationProvider({ sdk: fake.sdk, topics });
  };
  let current = build();
  let subscribed = false;
  const provider: NotificationProvider = {
    get provider() {
      return current.provider;
    },
    getCapabilities: () => current.getCapabilities(),
    getPermission: (request) => current.getPermission(request),
    requestPermission: (request) => current.requestPermission(request),
    register: () => current.register?.() ?? Promise.resolve(null),
    openSettings: () => current.openSettings?.() ?? Promise.resolve('unavailable'),
    subscribe(listener) {
      subscribed = true;
      return current.subscribe(listener);
    },
  };
  return {
    provider,
    host: createHostActor(
      fake,
      () => subscribed,
      () => {
        fake.setInitialUrl(plainLaunchUrl);
        current = build();
        subscribed = false;
      },
      () => {
        current = build();
      },
    ),
    hostAgreementEvidenceSchema: aitNotificationAgreementEvidenceSchema,
  };
}

function createHostActor(
  fake: FakeAitNotificationHost,
  isSubscribed: () => boolean,
  restart: () => void,
  launch: () => void,
): NotificationConformanceHostActor {
  const unscriptable = (what: string): never => {
    throw new NotificationConformanceScriptError(`The Apps in Toss host cannot script ${what}.`);
  };
  return {
    get prompts() {
      return fake.calls.length;
    },
    localOperations: [],
    // No local notifications exist on Apps in Toss.
    localPending: [],
    queuePrompt(result) {
      switch (result) {
        case 'granted':
          fake.queue({ kind: 'event', type: 'newAgreement' });
          return;
        case 'already-granted':
          fake.queue({ kind: 'event', type: 'alreadyAgreed' });
          return;
        case 'denied':
          fake.queue({ kind: 'event', type: 'agreementRejected' });
          return;
        case 'dismissed':
          fake.queue({ kind: 'silent' });
          return;
        case 'host-terms-declined':
          fake.queue({ kind: 'error', error: { code: 'TERMS_DISAGREED_MEMBER' } });
      }
    },
    setPermission: () => unscriptable('a permission change: agreements cannot be read or revoked in the app'),
    issueEndpoint: () => unscriptable('a device endpoint: recipients are platform users'),
    completeAction: () => unscriptable('a player action: the host never waits for one'),
    tap(input) {
      if (input.channel !== 'remote') {
        unscriptable('a local notification');
      }
      if (isSubscribed()) {
        unscriptable('a warm open: a Toss message opens the mini-app with a new launch');
      }
      const route = input.route ?? '/';
      fake.setInitialUrl(
        `intoss://fixture-game${route}${route.includes('?') ? '&' : '?'}referrer=push`,
      );
      // The message opens the mini-app with this launch: a new process reads it.
      launch();
    },
    restart,
  };
}

describe('Apps in Toss notifications provider conformance', () => {
  it('runs every vector whose appliesTo the Apps in Toss profile satisfies', () => {
    // No harness filter: a shared vector that does not fit the profile must
    // say so in its own appliesTo.
    const applicable = vectors
      .filter((vector) =>
        notificationConformanceSkipReason(vector, createAitNotificationCapabilities()) === undefined)
      .map((vector) => vector.vector);
    expect(applicable).toEqual(aitVectors);
  });

  for (const transport of ['direct', 'bridge'] as const) {
    it(`passes every vector its profile satisfies (${transport})`, async () => {
      const results = await runNotificationConformanceVectors(vectors, {
        createProvider: (context) => createAitHarness(context, transport),
      });
      const failed = results.filter((result) => result.status === 'failed');
      expect(failed).toEqual([]);
      expect(results.filter((result) => result.status === 'passed').map((result) => result.vector))
        .toEqual(aitVectors);
      for (const result of results.filter((entry) => entry.status === 'skipped')) {
        expect(result.reason).toMatch(/\S/u);
      }
    });
  }
});
