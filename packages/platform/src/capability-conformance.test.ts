import { describe, expect, it } from 'vitest';

import {
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
} from './capability-conformance';
import { createUnsupportedCommerceCapabilities, type CommerceCapabilities } from './commerce';
import {
  createUnsupportedCapabilities,
  type PlatformCapabilities,
  type PlatformGateway,
} from './index';
import type { NotificationCapabilities, NotificationProvider } from './notifications-contract';

describe('platform gateway capability conformance', () => {
  it('rejects an empty fixture set', rejectsEmptyFixtureSet);

  it('accepts fresh snapshots and observes provider transitions', acceptsFreshSnapshotsAndTransitions);

  it('rejects incomplete or unknown capability fields', rejectsMalformedSnapshots);

  it.each([
    [],
    '',
    null,
    { unknownFeature: 'available' },
    { rewardedAds: 'ready' },
  ])('rejects malformed provider availability %j', async (providerAvailability) => {
    const fixture = createFixture(() => ({
      ...createUnsupportedCapabilities(),
      providerAvailability: providerAvailability as NonNullable<
        PlatformCapabilities['providerAvailability']
      >,
    }));
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it('rejects gateways that leak a shared capability object', rejectsSharedSnapshot);

  it('rejects a provider mutation hidden by an aliased fixture expectation', rejectsAliasedExpectation);

  it('rejects a snapshot recycled after a provider transition', rejectsEarlierSnapshotAfterTransition);

  it('rejects duplicate fixture names', async () => {
    const fixture = createFixture(() => createUnsupportedCapabilities());

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture, fixture] }),
    ).rejects.toThrow('Duplicate platform capability conformance fixture: test-gateway.');
  });

  it('accepts transitions that only change provider readiness', async () => {
    let readiness: 'configuration-required' | 'temporarily-unavailable' = 'configuration-required';
    const base = createUnsupportedCapabilities();
    const fixture = {
      ...createFixture(() => ({
        ...fresh(base),
        providerAvailability: { rewardedAds: readiness },
      }), {
        update() { readiness = 'temporarily-unavailable'; },
        expectedCapabilities: {
          ...base,
          providerAvailability: { rewardedAds: 'temporarily-unavailable' },
        },
      }),
      expectedCapabilities: {
        ...base,
        providerAvailability: { rewardedAds: 'configuration-required' as const },
      },
    };
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it('rejects a provider-owned readiness record shared across snapshots', async () => {
    const readiness = { rewardedAds: 'unsupported' as const };
    const base = createUnsupportedCapabilities();
    const fixture = {
      ...createFixture(() => ({ ...fresh(base), providerAvailability: readiness })),
      expectedCapabilities: {
        ...base,
        providerAvailability: { rewardedAds: 'unsupported' as const },
      },
    };
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it('rejects empty fixture names', async () => {
    const fixture = {
      ...createFixture(() => createUnsupportedCapabilities()),
      name: ' ',
    };

    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).rejects.toThrow('Platform capability conformance fixture names must not be empty.');
  });

  it('accepts a fresh commerce block that matches the expected provider state', async () => {
    const expected = withCommerce(createAvailableCommerce());
    const fixture = createFixture(() => withCommerce(createAvailableCommerce()));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: expected }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it('observes a transition that only changes the commerce block', async () => {
    let finish: CommerceCapabilities['lifecycle']['finish'] = 'client';
    const snapshot = () => withCommerce({
      ...createAvailableCommerce(),
      lifecycle: { ...createAvailableCommerce().lifecycle, finish },
    });
    const fixture = createFixture(snapshot, {
      update() {
        finish = 'server';
      },
      expectedCapabilities: withCommerce({
        ...createAvailableCommerce(),
        lifecycle: { ...createAvailableCommerce().lifecycle, finish: 'server' },
      }),
    });
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: snapshot() }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it.each([
    ['a shared nested commerce object', (shared: CommerceCapabilities) => shared],
    ['a shared purchase block', (shared: CommerceCapabilities) => sharingOnly(shared, 'purchase')],
    ['a shared catalog block', (shared: CommerceCapabilities) => sharingOnly(shared, 'catalog')],
    ['a shared lifecycle block', (shared: CommerceCapabilities) => sharingOnly(shared, 'lifecycle')],
    ['a shared authority block', (shared: CommerceCapabilities) => sharingOnly(shared, 'authority')],
  ])('rejects %s across reads', async (_name, read) => {
    const shared = createAvailableCommerce();
    const fixture = createFixture(() => withCommerce(read(shared)));
    await expectRejection(
      { ...fixture, expectedCapabilities: withCommerce(createAvailableCommerce()) },
      'must match the expected provider state',
    );
  });

  // Each malformed block is also the expected state, so only the block's own
  // checks can reject it, and each case names the check that must.
  it.each([
    [
      'an unknown commerce key',
      { ...createAvailableCommerce(), bundles: true },
      'commerce capabilities must contain exactly purchase, catalog, lifecycle, authority, and availability',
    ],
    [
      'a group that is not a record',
      { ...createAvailableCommerce(), purchase: null },
      'commerce purchase capabilities must be a non-array record',
    ],
    [
      'an unknown purchase key',
      {
        ...createAvailableCommerce(),
        purchase: { ...createAvailableCommerce().purchase, gifting: false },
      },
      'commerce purchase capabilities must contain exactly consumable, durable, subscription, quantity',
    ],
    [
      'a missing lifecycle key',
      {
        ...createAvailableCommerce(),
        lifecycle: { availablePurchases: true, pending: true, restore: true, events: true },
      },
      'commerce lifecycle capabilities must contain exactly',
    ],
    [
      'a non-boolean flag',
      {
        ...createAvailableCommerce(),
        catalog: { products: 'yes', offers: false, localizedPrice: false },
      },
      'commerce capability catalog.products must be a boolean',
    ],
    [
      'an unknown finish owner',
      {
        ...createAvailableCommerce(),
        lifecycle: { ...createAvailableCommerce().lifecycle, finish: 'backend' },
      },
      'commerce capability lifecycle.finish must be one of client, server, host, none',
    ],
    [
      'an unknown readiness state',
      { ...createAvailableCommerce(), availability: 'ready' },
      'commerce availability must be a known readiness state',
    ],
    ['an array', [], 'commerce capabilities must be a non-array record'],
  ])('rejects %s in the commerce block', async (_name, commerce, cause) => {
    const capabilities = (): PlatformCapabilities => ({
      ...createUnsupportedCapabilities(),
      commerce: commerce as CommerceCapabilities,
    });
    const fixture = createFixture(capabilities);
    await expectRejection({ ...fixture, expectedCapabilities: capabilities() }, cause);
  });

  it('rejects a commerce block that differs from the expected state', async () => {
    const fixture = createFixture(() => withCommerce(createAvailableCommerce()));
    await expectRejection(
      {
        ...fixture,
        expectedCapabilities: withCommerce({
          ...createAvailableCommerce(),
          catalog: { ...createAvailableCommerce().catalog, offers: true },
        }),
      },
      'commerce capabilities must match the expected provider state',
    );
  });

  it('requires the commerce block: a snapshot without it fails, never defaults to unsupported', async () => {
    const withoutBlock = (): PlatformCapabilities => {
      const snapshot = { ...createUnsupportedCapabilities() };
      Reflect.deleteProperty(snapshot, 'commerce');
      return snapshot;
    };
    const fixture = createFixture(withoutBlock);
    await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
      .rejects.toMatchObject({
        cause: { message: expect.stringContaining('commerce capabilities are required') },
      });
  });

  it('rejects a commerce block that differs from the one the fixture expects', async () => {
    const present = createFixture(() => withCommerce(createAvailableCommerce()));
    await expectRejection(
      {
        ...present,
        expectedCapabilities: {
          ...createUnsupportedCapabilities(),
        },
      },
      'commerce capabilities must match the expected provider state',
    );
    const absent = createFixture(() => createUnsupportedCapabilities());
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...absent, expectedCapabilities: withCommerce(createAvailableCommerce()) }],
    })).rejects.toThrow('Platform gateway capability conformance failed: test-gateway.');
  });

  it('accepts a fresh notifications block whose availability is the push readiness', async () => {
    const fixture = exposingNotificationsV2(
      createFixture(() => withNotifications(createDeviceNotifications())),
    );
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: withNotifications(createDeviceNotifications()) }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
    // Optional counts may be left out, and purposes may come in any order.
    const minimal: NotificationCapabilities = {
      ...createDeviceNotifications(),
      permission: {
        scope: 'topic',
        prompt: 'host',
        readable: false,
        serverReadable: false,
        allowance: 'persistent',
        userGesture: true,
        settings: false,
      },
      remote: {
        supported: true,
        purposes: ['requested', 'service'],
        addressing: 'platform-user',
        content: 'host-template',
      },
      local: { supported: false },
      open: 'landing-url',
    };
    const reordered = exposingNotificationsV2(createFixture(() => withNotifications({
      ...copyNotifications(minimal),
      remote: { ...minimal.remote, purposes: ['service', 'requested'] },
    })));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...reordered, expectedCapabilities: withNotifications(minimal) }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
    // A topic-scoped host may cap the topics one prompt asks for.
    const perTopic: NotificationCapabilities = {
      ...minimal,
      permission: { ...minimal.permission, maxTopicsPerPrompt: 3 },
    };
    const capped = exposingNotificationsV2(
      createFixture(() => withNotifications(copyNotifications(perTopic))),
    );
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...capped, expectedCapabilities: withNotifications(perTopic) }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it('observes a transition that only changes the notifications block', async () => {
    let availability: NotificationCapabilities['availability'] = 'available';
    const snapshot = () => withNotifications({ ...createDeviceNotifications(), availability });
    const fixture = exposingNotificationsV2(createFixture(snapshot, {
      update() {
        availability = 'action-required';
      },
      expectedCapabilities: withNotifications({
        ...createDeviceNotifications(),
        availability: 'action-required',
      }),
    }));
    await expect(runPlatformGatewayCapabilityConformance({
      fixtures: [{ ...fixture, expectedCapabilities: snapshot() }],
    })).resolves.toEqual({ passedFixtures: ['test-gateway'] });
  });

  it.each([
    ['the whole block', (shared: NotificationCapabilities) => shared],
    ['the permission record', (shared: NotificationCapabilities) => ({
      ...copyNotifications(shared),
      permission: shared.permission,
    })],
    ['the remote record', (shared: NotificationCapabilities) => ({
      ...copyNotifications(shared),
      remote: shared.remote,
    })],
    ['the purposes list', (shared: NotificationCapabilities) => ({
      ...copyNotifications(shared),
      remote: { ...shared.remote, purposes: shared.remote.purposes },
    })],
    ['the local record', (shared: NotificationCapabilities) => ({
      ...copyNotifications(shared),
      local: shared.local,
    })],
  ])('rejects a notifications block that shares %s across reads', async (_name, read) => {
    const shared = createDeviceNotifications();
    const fixture = exposingNotificationsV2(createFixture(() => withNotifications(read(shared))));
    await expectRejection(
      { ...fixture, expectedCapabilities: withNotifications(createDeviceNotifications()) },
      'must match the expected provider state',
    );
  });

  it('rejects an empty purposes list shared across reads', async () => {
    const remoteOff = (): NotificationCapabilities => ({
      ...createDeviceNotifications(),
      remote: { supported: false, purposes: [], addressing: 'none', content: 'free-form' },
    });
    const shared = remoteOff();
    const fixture = exposingNotificationsV2(createFixture(() => withNotifications({
      ...copyNotifications(shared),
      remote: { ...shared.remote, purposes: shared.remote.purposes },
    })));
    await expectRejection(
      { ...fixture, expectedCapabilities: withNotifications(remoteOff()) },
      'notification capabilities must match the expected provider state',
    );
  });

  it.each(['block', 'permission', 'remote', 'local', 'purposes'] as const)(
    'rejects reused frozen notification %s data', async (part) => {
      const original = createDeviceNotifications();
      const shared: NotificationCapabilities = Object.freeze({
        ...original,
        permission: Object.freeze(original.permission),
        remote: Object.freeze({
          ...original.remote,
          purposes: Object.freeze([...original.remote.purposes]),
        }),
        local: Object.freeze(original.local),
      });
      const read = (): NotificationCapabilities => {
        const copy = copyNotifications(shared);
        switch (part) {
          case 'block':
            return shared;
          case 'permission':
            return { ...copy, permission: shared.permission };
          case 'remote':
            return { ...copy, remote: shared.remote };
          case 'local':
            return { ...copy, local: shared.local };
          case 'purposes':
            return { ...copy, remote: { ...copy.remote, purposes: shared.remote.purposes } };
        }
      };
      const fixture = exposingNotificationsV2(createFixture(() => withNotifications(read())));
      await expectRejection(
        { ...fixture, expectedCapabilities: withNotifications(createDeviceNotifications()) },
        'notification capabilities must return a fresh',
      );
    },
  );

  // As for commerce: each malformed block is also the expected state.
  it.each([
    [
      'a sparse purposes list',
      {
        ...createDeviceNotifications(),
        remote: { ...createDeviceNotifications().remote, purposes: new Array(1) },
      },
      'notification capability remote.purposes must list only service, requested, advertising',
    ],
    [
      'an unknown key',
      { ...createDeviceNotifications(), timing: 'exact' },
      'notification capabilities must contain exactly availability, permission, remote, local, and open',
    ],
    [
      'a group that is not a record',
      { ...createDeviceNotifications(), local: [] },
      'notification local capabilities must be a non-array record',
    ],
    [
      'an unknown permission key',
      {
        ...createDeviceNotifications(),
        permission: { ...createDeviceNotifications().permission, exactAlarms: true },
      },
      'notification permission capabilities must contain no unknown keys',
    ],
    [
      'a missing permission key',
      {
        ...createDeviceNotifications(),
        permission: { scope: 'app', prompt: 'os', readable: true, allowance: 'persistent' },
      },
      'notification capability permission.serverReadable is required',
    ],
    [
      'a non-boolean flag',
      {
        ...createDeviceNotifications(),
        permission: { ...createDeviceNotifications().permission, readable: 'yes' },
      },
      'notification capability permission.readable must be a boolean',
    ],
    [
      'an unknown prompt owner',
      {
        ...createDeviceNotifications(),
        permission: { ...createDeviceNotifications().permission, prompt: 'browser' },
      },
      'notification capability permission.prompt must be one of os, host, game',
    ],
    [
      'a zero prompt limit',
      {
        ...createDeviceNotifications(),
        permission: { ...createDeviceNotifications().permission, promptLimit: 0 },
      },
      'notification capability permission.promptLimit must be a positive integer',
    ],
    [
      'a zero topics-per-prompt cap',
      {
        ...createDeviceNotifications(),
        permission: { ...createDeviceNotifications().permission, maxTopicsPerPrompt: 0 },
      },
      'notification capability permission.maxTopicsPerPrompt must be a positive integer',
    ],
    [
      'a fractional pending ceiling',
      { ...createDeviceNotifications(), local: { supported: true, maxPending: 1.5 } },
      'notification capability local.maxPending must be a positive integer',
    ],
    [
      'a pending ceiling beyond 32 bits',
      { ...createDeviceNotifications(), local: { supported: true, maxPending: 2 ** 32 } },
      'notification capability local.maxPending must be a positive integer',
    ],
    [
      'an unknown purpose',
      {
        ...createDeviceNotifications(),
        remote: { ...createDeviceNotifications().remote, purposes: ['marketing'] },
      },
      'notification capability remote.purposes must list only service, requested, advertising',
    ],
    [
      'purposes that are not a list',
      {
        ...createDeviceNotifications(),
        remote: { ...createDeviceNotifications().remote, purposes: { 0: 'service' } },
      },
      'notification capability remote.purposes must list only service, requested, advertising',
    ],
    [
      "addressing 'none' with remote delivery",
      {
        ...createDeviceNotifications(),
        remote: { ...createDeviceNotifications().remote, addressing: 'none' },
      },
      "notification remote.addressing must be 'none' exactly when remote.supported is false",
    ],
    [
      'remote delivery off with an address',
      {
        ...createDeviceNotifications(),
        remote: { ...createDeviceNotifications().remote, supported: false },
      },
      "notification remote.addressing must be 'none' exactly when remote.supported is false",
    ],
    [
      'an unknown open path',
      { ...createDeviceNotifications(), open: 'deep-link' },
      'notification open must be one of payload, landing-url, host-link, none',
    ],
    [
      'an unknown readiness state',
      { ...createDeviceNotifications(), availability: 'ready' },
      'notification availability must be a known readiness state',
    ],
    ['an array', [], 'notification capabilities must be a non-array record'],
  ])('rejects %s in the notifications block', async (_name, notifications, cause) => {
    const capabilities = (): PlatformCapabilities => ({
      ...createUnsupportedCapabilities(),
      providerAvailability: { pushNotifications: 'available' },
      notifications: notifications as NotificationCapabilities,
    });
    const fixture = exposingNotificationsV2(createFixture(capabilities));
    await expectRejection({ ...fixture, expectedCapabilities: capabilities() }, cause);
  });

  it('rejects a notifications block that differs from the expected state', async () => {
    const fixture = exposingNotificationsV2(
      createFixture(() => withNotifications(createDeviceNotifications())),
    );
    await expectRejection(
      {
        ...fixture,
        expectedCapabilities: withNotifications({
          ...createDeviceNotifications(),
          open: 'landing-url',
        }),
      },
      'notification capabilities must match the expected provider state',
    );
  });

  it('rejects a push readiness that disagrees with the notifications block', async () => {
    const readiness: readonly (PlatformCapabilities['providerAvailability'] | undefined)[] = [
      { pushNotifications: 'configuration-required' },
      undefined,
    ];
    for (const providerAvailability of readiness) {
      const capabilities = (): PlatformCapabilities => ({
        ...createUnsupportedCapabilities(),
        ...(providerAvailability === undefined ? {} : { providerAvailability }),
        notifications: createDeviceNotifications(),
      });
      const fixture = exposingNotificationsV2(createFixture(capabilities));
      await expectRejection(
        { ...fixture, expectedCapabilities: capabilities() },
        'providerAvailability.pushNotifications must equal the notification capabilities availability',
      );
    }
  });

  it('ties the notifications block to the exposed notificationsV2 provider', async () => {
    // Exposed without a block, whatever the push readiness says.
    const unblocked = (): PlatformCapabilities => ({
      ...createUnsupportedCapabilities(),
      providerAvailability: { pushNotifications: 'configuration-required' },
    });
    await expectRejection(
      {
        ...exposingNotificationsV2(createFixture(unblocked)),
        expectedCapabilities: unblocked(),
      },
      'notification capabilities must be present exactly when the gateway exposes notificationsV2',
    );
    // A block without an exposed provider.
    const blocked = (): PlatformCapabilities => withNotifications(createDeviceNotifications());
    await expectRejection(
      { ...createFixture(blocked), expectedCapabilities: blocked() },
      'notification capabilities must be present exactly when the gateway exposes notificationsV2',
    );
  });

  it('rejects a notifications block the fixture does not expect, and the reverse', async () => {
    const present = exposingNotificationsV2(
      createFixture(() => withNotifications(createDeviceNotifications())),
    );
    await expectRejection(
      {
        ...present,
        expectedCapabilities: {
          ...createUnsupportedCapabilities(),
          providerAvailability: { pushNotifications: 'available' },
        },
      },
      'notification capabilities must be absent when the fixture omits them',
    );
    const absent = createFixture(() => ({
      ...createUnsupportedCapabilities(),
      providerAvailability: { pushNotifications: 'available' },
    }));
    await expectRejection(
      { ...absent, expectedCapabilities: withNotifications(createDeviceNotifications()) },
      'notification capabilities must be present when the fixture expects them',
    );
  });
});

/** Expects the runner to reject the fixture, with `cause` naming the check that failed. */
async function expectRejection(
  fixture: PlatformGatewayCapabilityConformanceFixture,
  cause: string,
): Promise<void> {
  await expect(runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }))
    .rejects.toMatchObject({
      message: 'Platform gateway capability conformance failed: test-gateway.',
      cause: { message: expect.stringContaining(cause) },
    });
}

/** The fixture's gateway also exposes a notifications v2 provider, which the runner never calls. */
function exposingNotificationsV2(
  fixture: PlatformGatewayCapabilityConformanceFixture,
): PlatformGatewayCapabilityConformanceFixture {
  const provider: NotificationProvider = {
    provider: 'fcm',
    async getCapabilities() {
      return createDeviceNotifications();
    },
    async getPermission() {
      return { app: 'granted', topics: {} };
    },
    async requestPermission() {
      return { snapshot: { app: 'granted', topics: {} }, outcomes: {} };
    },
    subscribe() {
      return () => {};
    },
  };
  return { ...fixture, gateway: { ...fixture.gateway, notificationsV2: provider } };
}

/** The Capacitor + FCM profile (notifications RFC "Provider profiles"). */
function createDeviceNotifications(): NotificationCapabilities {
  return {
    availability: 'available',
    permission: {
      scope: 'app',
      prompt: 'os',
      readable: true,
      serverReadable: false,
      allowance: 'persistent',
      userGesture: false,
      promptLimit: 2,
      settings: true,
    },
    remote: {
      supported: true,
      purposes: ['service', 'requested', 'advertising'],
      addressing: 'device',
      content: 'free-form',
    },
    local: { supported: true, maxPending: 64 },
    open: 'payload',
  };
}

function copyNotifications(value: NotificationCapabilities): NotificationCapabilities {
  return {
    availability: value.availability,
    permission: { ...value.permission },
    remote: { ...value.remote, purposes: [...value.remote.purposes] },
    local: { ...value.local },
    open: value.open,
  };
}

function withNotifications(notifications: NotificationCapabilities): PlatformCapabilities {
  return {
    ...createUnsupportedCapabilities(),
    providerAvailability: { pushNotifications: notifications.availability },
    notifications,
  };
}

/** A fresh commerce block that reuses exactly one nested record from `shared`. */
function sharingOnly(
  shared: CommerceCapabilities,
  block: 'purchase' | 'catalog' | 'lifecycle' | 'authority',
): CommerceCapabilities {
  return {
    purchase: block === 'purchase' ? shared.purchase : { ...shared.purchase },
    catalog: block === 'catalog' ? shared.catalog : { ...shared.catalog },
    lifecycle: block === 'lifecycle' ? shared.lifecycle : { ...shared.lifecycle },
    authority: block === 'authority' ? shared.authority : { ...shared.authority },
    availability: shared.availability,
  };
}

function createAvailableCommerce(): CommerceCapabilities {
  return {
    ...createUnsupportedCommerceCapabilities(),
    purchase: { consumable: true, durable: true, subscription: false, quantity: false },
    availability: 'available',
  };
}

/** A copy that shares no nested record, as a conforming gateway returns on every read. */
function fresh(value: PlatformCapabilities): PlatformCapabilities {
  return {
    ...value,
    ...(value.providerAvailability === undefined
      ? {}
      : { providerAvailability: { ...value.providerAvailability } }),
    commerce: {
      purchase: { ...value.commerce.purchase },
      catalog: { ...value.commerce.catalog },
      lifecycle: { ...value.commerce.lifecycle },
      authority: { ...value.commerce.authority },
      availability: value.commerce.availability,
    },
  };
}

function withCommerce(commerce: CommerceCapabilities): PlatformCapabilities {
  return {
    ...createUnsupportedCapabilities(),
    commerce,
  };
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#fixture-validation An empty fixture list is rejected before a gateway is read.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#fixture-validation #d566052 Verified the empty-input assertion and related fixture-name cases in this suite.
 */
export async function rejectsEmptyFixtureSet(): Promise<void> {
  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [] }),
  ).rejects.toThrow(
    'Platform gateway capability conformance requires at least one fixture.',
  );
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Exercises fresh boolean snapshots against expected values.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Verified that the fixture returns a new object on every read, including optional readiness handling.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Exercises a provider update and the expected post-update snapshot.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Verified that the fixture changes cloudSave and the runner rereads it.
 */
export async function acceptsFreshSnapshotsAndTransitions(): Promise<void> {
  let capabilities = createUnsupportedCapabilities();
  const fixture = createFixture(() => fresh(capabilities), {
    update() {
      capabilities = {
        ...capabilities,
        cloudSave: true,
      };
    },
    expectedCapabilities: {
      ...createUnsupportedCapabilities(),
      cloudSave: true,
    },
  });

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).resolves.toEqual({ passedFixtures: ['test-gateway'] });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects a provider that returns the same snapshot object twice.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Confirmed the runner rejects object reuse after its attempted mutation, including nested readiness records.
 */
export async function rejectsSharedSnapshot(): Promise<void> {
  const capabilities = Object.freeze(createUnsupportedCapabilities());
  const fixture = createFixture(() => capabilities);

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).rejects.toMatchObject({
    cause: { message: expect.stringContaining('getCapabilities must return a fresh snapshot') },
  });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Ensures the expected state cannot move with a provider-owned snapshot.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Compared first and second reads against a detached expectation after mutation.
 */
export async function rejectsAliasedExpectation(): Promise<void> {
  const expected = { ...createUnsupportedCapabilities() };
  let reads = 0;
  const fixture = {
    ...createFixture(() => {
      reads += 1;
      return reads === 1 ? expected : fresh(expected);
    }),
    expectedCapabilities: expected,
  };

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('capability nativeAds must match the expected provider state'),
    },
  });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects reuse of a non-adjacent snapshot object.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Verified reuse of the first top-level object after a transition remains invalid.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Covers identity reuse after an otherwise valid provider transition.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Checked the update changes cloudSave before the third read.
 */
export async function rejectsEarlierSnapshotAfterTransition(): Promise<void> {
  const first = { ...createUnsupportedCapabilities() };
  const second = { ...createUnsupportedCapabilities() };
  let reads = 0;
  const fixture = createFixture(
    () => {
      reads += 1;
      return reads === 2 ? second : first;
    },
    {
      update() {
        Object.assign(first, { cloudSave: true });
      },
      expectedCapabilities: { ...createUnsupportedCapabilities(), cloudSave: true },
    },
  );

  await expect(
    runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('must not reuse an earlier snapshot'),
    },
  });
}

/**
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Rejects a missing required key and an unknown key.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Checked missing and unknown top-level fields against the runner's shape guard.
 */
export async function rejectsMalformedSnapshots(): Promise<void> {
  const missing = { ...createUnsupportedCapabilities() };
  Reflect.deleteProperty(missing, 'nativeAds');
  const unknown = { ...createUnsupportedCapabilities(), unknownCapability: true };

  for (const capabilities of [missing, unknown]) {
    const fixture = createFixture(() => capabilities);
    await expect(
      runPlatformGatewayCapabilityConformance({ fixtures: [fixture] }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining(
          'capability snapshots must contain all required keys and no unknown keys',
        ),
      },
    });
  }
}

function createFixture(
  getCapabilities: () => Promise<PlatformCapabilities> | PlatformCapabilities,
  transition?: PlatformGatewayCapabilityConformanceFixture['transition'],
): PlatformGatewayCapabilityConformanceFixture {
  const gateway: PlatformGateway = {
    target: 'browser',
    async getCapabilities() {
      return getCapabilities();
    },
    identity: {
      async getPlayer() {
        return null;
      },
    },
    ads: {
      async preload() {},
      async showRewarded() {
        return { status: 'unavailable', rewardGranted: false };
      },
    },
    leaderboard: {
      async submitScore() {
        return { submitted: false };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };

  return {
    name: 'test-gateway',
    gateway,
    expectedTarget: 'browser',
    expectedCapabilities: createUnsupportedCapabilities(),
    ...(transition === undefined ? {} : { transition }),
  };
}
