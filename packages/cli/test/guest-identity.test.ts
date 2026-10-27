import assert from 'node:assert/strict';

import {
  gameServicesPlayerChangedCode,
  GuestSessionRejectedError,
  type GameServicesRuntime,
  type GuestSessionBackend,
  type ServerGuestSessionCredentials,
} from '@mpgd/game-services';
import type { IdentitySession, PlatformGateway, SecureCredentialStore } from '@mpgd/platform';

import {
  resolvePlayBillingAccountBinding,
  resolveStarterCommercePlayerId,
  resolveStoreKitAppAccountToken,
  setStarterCommerceServerPlayer,
} from '../templates/phaser-game/src/platform/commerceAccountBinding.js';
import {
  createStarterGuestSignIn,
  starterGuestSignInRetryDelaysMs,
  starterInstallationIdKey,
  startStarterGuestIdentity,
} from '../templates/phaser-game/src/platform/guestIdentity.js';
import {
  bindStarterServicesToPlayer,
  createSessionGatedGameServices,
  starterSessionRequiredCode,
  StarterSessionRequiredError,
} from '../templates/phaser-game/src/platform/sessionGatedServices.js';

// The generated game's guest sign-in against an identity service (the reference
// Worker's rotation rules, in memory; apps/game-identity-worker tests the Worker itself), and
// how store purchases bind to the server player instead of the native shell's local one.

const identityUrl = 'https://identity.example.test';

function secureStore(): { credentials: SecureCredentialStore; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    credentials: {
      async load({ key }) {
        return values.get(key) ?? null;
      },
      async save({ key, value }) {
        values.set(key, value);
      },
      async remove({ key }) {
        values.delete(key);
      },
    },
  };
}

/** The native shell's platform session: a local placeholder player. */
const nativeShell = {
  identity: {
    async getPlayer() {
      return { playerId: 'ios-local-player', displayName: 'Local Player' };
    },
    async getSession(): Promise<IdentitySession> {
      return { identityLevel: 'guest', playerId: 'ios-local-player', trustLevel: 'local' };
    },
  },
} as unknown as Pick<PlatformGateway, 'identity'>;

/** Issue, rotate (a used refresh token is dead), and revoke, as the identity Worker does. */
function identityService(): GuestSessionBackend {
  let counter = 0;
  const live = new Map<string, { playerId: string; familyId: string }>();
  const revoked = new Set<string>();
  const credentialsFor = (playerId: string, familyId: string): ServerGuestSessionCredentials => {
    counter += 1;
    const refreshToken = `mpgd_rt_${familyId}_${counter}`;
    live.set(refreshToken, { playerId, familyId });
    return {
      serverUserId: playerId,
      sessionId: familyId,
      sessionFamilyId: familyId,
      identityLevel: 'guest',
      accessToken: `mpgd_at_${familyId}_${counter}`,
      refreshToken,
      accessExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  };
  return {
    async issueGuest() {
      counter += 1;
      return credentialsFor(`p_${String(counter).padStart(32, '0')}`, `s_${counter}`);
    },
    async refresh({ refreshToken }) {
      const found = live.get(refreshToken);
      if (found === undefined || revoked.has(found.familyId)) {
        throw new GuestSessionRejectedError();
      }
      live.delete(refreshToken);
      return credentialsFor(found.playerId, found.familyId);
    },
    async revoke({ refreshToken }) {
      const found = live.get(refreshToken);
      if (found !== undefined) {
        revoked.add(found.familyId);
      }
    },
    async bindAccount() {
      throw new Error('ACCOUNT_BINDING_UNSUPPORTED');
    },
  };
}

const backend = identityService();
const warnings: string[] = [];
const warn = (message: string) => warnings.push(message);

// Without an identity URL nothing changes: the local player binds no purchase.
{
  setStarterCommerceServerPlayer(undefined);
  assert.deepEqual(
    await startStarterGuestIdentity({ identityUrl: undefined, credentials: secureStore().credentials, warn }),
    { status: 'not-configured' },
  );
  assert.equal(await resolveStarterCommercePlayerId(nativeShell), undefined);
  assert.equal(await resolvePlayBillingAccountBinding(nativeShell), undefined);
  await assert.rejects(resolveStoreKitAppAccountToken(nativeShell), /VITE_MPGD_IDENTITY_URL/u);
  // A target without a secure store (a browser build) keeps no refresh token.
  assert.deepEqual(await startStarterGuestIdentity({ identityUrl, credentials: undefined, warn }), {
    status: 'unavailable',
  });
  assert.match(warnings.at(-1) ?? '', /no secure credential store/u);
}

// First launch: a server-issued guest; purchases bind to it, and the server session is set.
const device = secureStore();
const first = await startStarterGuestIdentity({
  identityUrl,
  credentials: device.credentials,
  backend,
  createInstallationId: () => 'install-template-0001',
  warn,
});
assert.equal(first.status, 'signed-in');
assert.ok(first.status === 'signed-in');
assert.match(first.playerId, /^p_[0-9]{32}$/u);
assert.equal(device.values.get(starterInstallationIdKey), 'install-template-0001');
assert.equal(await resolveStarterCommercePlayerId(nativeShell), first.playerId);
const playBinding = await resolvePlayBillingAccountBinding(nativeShell);
assert.equal(playBinding?.kind, 'obfuscated-account-id');
assert.match(playBinding?.value ?? '', /^[0-9a-f]{64}$/u);
assert.match(
  await resolveStoreKitAppAccountToken(nativeShell),
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const session = first.serverSession;
assert.deepEqual(session?.current(), {
  playerId: first.playerId,
  sessionId: first.coordinator.current()?.sessionFamilyId,
});
assert.match((await session?.getHeaders())?.authorization ?? '', /^Bearer mpgd_at_/u);

// Next launch: the same guest from the device's secure store.
const second = await startStarterGuestIdentity({
  identityUrl,
  credentials: device.credentials,
  backend,
  warn,
});
assert.ok(second.status === 'signed-in');
assert.equal(second.playerId, first.playerId);
assert.equal(device.values.get(starterInstallationIdKey), 'install-template-0001');

// A session the service ended (here: logged out elsewhere) is replaced by a new guest.
const stored = device.values.get('mpgd.guest.refresh');
assert.ok(stored !== undefined);
await backend.revoke({ refreshToken: stored });
const third = await startStarterGuestIdentity({
  identityUrl,
  credentials: device.credentials,
  backend,
  warn,
});
assert.ok(third.status === 'signed-in');
assert.notEqual(third.playerId, first.playerId);
assert.match(warnings.at(-1) ?? '', /starting a new guest/u);
assert.equal(await resolveStarterCommercePlayerId(nativeShell), third.playerId);

// An outage: no session, and purchases bind to nothing, never to the local player.
const failing: GuestSessionBackend = {
  async issueGuest() {
    throw new Error('offline');
  },
  async refresh() {
    throw new Error('offline');
  },
  async revoke() {},
  async bindAccount() {
    throw new Error('offline');
  },
};
const authenticatedShell = {
  identity: {
    async getPlayer() {
      return null;
    },
    async getSession(): Promise<IdentitySession> {
      return {
        identityLevel: 'authenticated',
        playerId: 'platform-player',
        trustLevel: 'platform-asserted',
      };
    },
  },
} as unknown as Pick<PlatformGateway, 'identity'>;
const offline = await startStarterGuestIdentity({
  identityUrl,
  credentials: secureStore().credentials,
  backend: failing,
  warn,
});
assert.deepEqual(offline, { status: 'failed', code: 'GUEST_SESSION_BACKEND_FAILED' });
assert.match(warnings.at(-1) ?? '', /purchases stay unavailable/u);
assert.equal(await resolveStarterCommercePlayerId(authenticatedShell), undefined);
await assert.rejects(resolveStoreKitAppAccountToken(authenticatedShell), /server session/u);

// An invalid stored installation id is replaced, not sent.
{
  const other = secureStore();
  other.values.set(starterInstallationIdKey, 'bad id');
  const signedIn = await startStarterGuestIdentity({
    identityUrl,
    credentials: other.credentials,
    backend,
    createInstallationId: () => 'install-template-0002',
    warn,
  });
  assert.equal(signedIn.status, 'signed-in');
  assert.equal(other.values.get(starterInstallationIdKey), 'install-template-0002');
}

// The secure store fails: no session, nothing binds, and the failure is reported, not thrown.
{
  // A player bound from an earlier sign-in must not survive the failure.
  setStarterCommerceServerPlayer(() => 'p_stale');
  const broken: SecureCredentialStore = {
    async load({ key }) {
      return key === starterInstallationIdKey ? 'install-template-0003' : null;
    },
    async save({ key }) {
      // The installation id is stored; the refresh token, after the server issued a guest, is not.
      if (key === 'mpgd.guest.refresh') {
        throw new Error('keychain unavailable');
      }
    },
    async remove() {},
  };
  assert.deepEqual(
    await startStarterGuestIdentity({ identityUrl, credentials: broken, backend, warn }),
    {
      status: 'failed',
      code: 'GUEST_SESSION_CREDENTIAL_SAVE_FAILED',
    },
  );
  assert.equal(await resolveStarterCommercePlayerId(authenticatedShell), undefined);
  // An installation id that cannot be stored fails before any request.
  const noStore: SecureCredentialStore = {
    async load() {
      return null;
    },
    async save() {
      throw new Error('keychain unavailable');
    },
    async remove() {},
  };
  assert.deepEqual(
    await startStarterGuestIdentity({ identityUrl, credentials: noStore, backend, warn }),
    {
      status: 'failed',
      code: 'GUEST_IDENTITY_FAILED',
    },
  );
}

// An ended session whose revoke fails during replacement: the dead token stays, and the launch fails.
{
  const other = secureStore();
  const signedIn = await startStarterGuestIdentity({
    identityUrl,
    credentials: other.credentials,
    backend,
    warn,
  });
  assert.ok(signedIn.status === 'signed-in');
  assert.equal(signedIn.identityLevel, 'guest');
  const token = other.values.get('mpgd.guest.refresh');
  assert.ok(token !== undefined);
  await backend.revoke({ refreshToken: token });
  const revokeFails: GuestSessionBackend = {
    ...backend,
    async revoke() {
      throw new Error('offline');
    },
  };
  const result = await startStarterGuestIdentity({
    identityUrl,
    credentials: other.credentials,
    backend: revokeFails,
    warn,
  });
  assert.deepEqual(result, { status: 'failed', code: 'GUEST_SESSION_LOGOUT_UNCERTAIN' });
  assert.equal(other.values.get('mpgd.guest.refresh'), token);
}

// Launched offline: the sign-in retries in the background with backoff, at
// once when the network returns, and on demand before a purchase or restore.
{
  setStarterCommerceServerPlayer(undefined);
  let online = false;
  const flaky: GuestSessionBackend = {
    async issueGuest(input) {
      if (!online) {
        throw new Error('offline');
      }
      return backend.issueGuest(input);
    },
    async refresh(input) {
      if (!online) {
        throw new Error('offline');
      }
      return backend.refresh(input);
    },
    revoke: (input) => backend.revoke(input),
    bindAccount: (input) => backend.bindAccount(input),
  };
  const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];
  let fireOnline: (() => void) | undefined;
  const signIn = createStarterGuestSignIn({
    identityUrl,
    credentials: secureStore().credentials,
    backend: flaky,
    warn,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onOnline: (callback) => {
      fireOnline = callback;
      return () => {
        fireOnline = undefined;
      };
    },
  });
  assert.equal(signIn.configured, true);
  const heard: string[] = [];
  signIn.onSignedIn((signedIn) => heard.push(signedIn.playerId));
  assert.equal(await signIn.ensure(), undefined);
  // Backoff: one pending retry at a time, growing delays.
  const fire = async () => {
    const timer = timers.filter((entry) => !entry.cancelled).at(-1);
    assert.ok(timer !== undefined);
    timer.cancelled = true;
    timer.callback();
    await signIn.ensure();
  };
  await fire();
  await fire();
  assert.deepEqual(
    timers.map((timer) => timer.delayMs),
    starterGuestSignInRetryDelaysMs.slice(0, 3),
  );
  // Failed attempts a player starts (a purchase, a restore tap) do not lengthen the backoff.
  assert.equal(await signIn.ensure(), undefined);
  assert.equal(await signIn.ensure(), undefined);
  assert.equal(timers.at(-1)?.delayMs, starterGuestSignInRetryDelaysMs[2]);
  // The network returns: the online event signs in without waiting for the timer.
  online = true;
  fireOnline?.();
  const signedIn = await signIn.ensure();
  assert.ok(signedIn !== undefined);
  assert.deepEqual(heard, [signedIn.playerId]);
  assert.equal(timers.filter((timer) => !timer.cancelled).length, 0, 'no retry is left pending');
  assert.equal(fireOnline, undefined, 'the online listener is removed');
  assert.equal(await resolveStarterCommercePlayerId(nativeShell), signedIn.playerId);
  // A listener registered after the sign-in (a retry won the race with the boot) hears it at once.
  const lateHeard: string[] = [];
  signIn.onSignedIn((late) => lateHeard.push(late.playerId));
  assert.deepEqual(lateHeard, [signedIn.playerId]);
  // Without an identity URL nothing is tried or retried.
  const off = createStarterGuestSignIn({
    identityUrl: undefined,
    credentials: secureStore().credentials,
    warn,
  });
  assert.equal(off.configured, false);
  assert.equal(await off.ensure(), undefined);
}

// The session-gated game services: up only for the server player, never the local one.
{
  const created: string[] = [];
  const purchases: string[] = [];
  const reconciles: string[] = [];
  const deletionFor = new Map<string, NonNullable<GameServicesRuntime['accountDeletion']>>();
  const disposed: string[] = [];
  const runtimeFor = (playerId: string): GameServicesRuntime => ({
    mode: 'http',
    async dispose() {
      disposed.push(playerId);
    },
    accountDeletion: deletionFor.get(playerId) ?? deletionFor.set(playerId, {
      deleteAccount: () => Promise.reject(new Error('not called')),
    }).get(playerId)!,
    client: {
      async purchase(input) {
        purchases.push(`${playerId}:${input.productId}`);
        return { status: 'granted' } as never;
      },
      async claimRewardedAd() {
        return { status: 'granted' } as never;
      },
      async submitLeaderboardScore() {
        return { submitted: true } as never;
      },
    },
    monetizationRecovery: {
      async purchase() {
        return { status: 'granted' } as never;
      },
      async claimRewardedAd() {
        return { status: 'granted' } as never;
      },
      async recoverRewardResult() {
        return { status: 'granted' } as never;
      },
      async reconcile() {
        reconciles.push(playerId);
        return [];
      },
      async restorePurchases() {
        return [];
      },
    },
  });
  const signedInAs: { player?: string } = {};
  const changedTo: string[] = [];
  let activations = 0;
  let notify: ((playerId: string) => void) | undefined;
  const gated = createSessionGatedGameServices({
    probe: { ...runtimeFor('session-pending'), mode: 'http' },
    ensurePlayer: async () => signedInAs.player,
    onPlayer: (listener) => {
      notify = listener;
      return () => undefined;
    },
    create: (playerId) => {
      created.push(playerId);
      return runtimeFor(playerId);
    },
    onActivated: () => {
      activations += 1;
    },
    onPlayerChanged: (playerId) => {
      changedTo.push(playerId);
    },
    warn,
  });
  assert.equal(gated.mode, 'http');
  // Rewarded ads and restore stay off; the client exists so the action coordinator does.
  assert.equal(gated.monetizationRecovery, undefined);
  assert.equal(gated.accountDeletion, undefined);
  let readyCalls = 0;
  gated.onReady(() => {
    readyCalls += 1;
  });
  const unsubscribed = gated.onReady(() => {
    throw new Error('unsubscribed');
  });
  unsubscribed();
  assert.ok(gated.client !== undefined);
  // A refusal the action coordinator reads as a plain failure (a throw would latch it).
  assert.deepEqual(
    await gated.client.purchase({ productId: 'REMOVE_ADS', source: 'shop', idempotencyKey: 'k1' }),
    {
      status: 'failed',
      purchase: {
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: starterSessionRequiredCode, retryable: true },
      },
    },
  );
  assert.equal(
    (await gated.client.claimRewardedAd({ placementId: 'CONTINUE_AFTER_FAIL', idempotencyKey: 'r1' })).status,
    'unavailable',
  );
  await assert.rejects(
    gated.client.submitLeaderboardScore({} as never),
    StarterSessionRequiredError,
  );
  assert.equal(await gated.ensureSession?.(), false);
  assert.deepEqual(created, []);
  // A purchase after the network returned signs in first, then buys for the server player.
  signedInAs.player = 'p_server';
  const bought = await gated.client.purchase({
    productId: 'REMOVE_ADS',
    source: 'shop',
    idempotencyKey: 'k2',
  });
  assert.equal(bought.status, 'granted');
  assert.deepEqual(created, ['p_server']);
  assert.deepEqual(purchases, ['p_server:REMOVE_ADS']);
  // The startup recovery is the game runtime's reconcile, which main.ts runs from onActivated.
  assert.deepEqual(reconciles, []);
  assert.equal(activations, 1);
  assert.ok(gated.monetizationRecovery !== undefined);
  assert.equal(gated.accountDeletion, deletionFor.get('p_server'));
  assert.equal(readyCalls, 1, 'Delete account hears the services come up');
  assert.equal(await gated.ensureSession?.(), true);
  // A later sign-in naming another player closes the services (fail closed):
  // nothing is created for it in this run, and the host restarts for it.
  notify?.('p_other');
  assert.deepEqual(created, ['p_server']);
  assert.equal(activations, 1, 'activated once');
  assert.equal(readyCalls, 1, 'ready once');
  assert.match(warnings.at(-1) ?? '', /another player/u);
  assert.deepEqual(disposed, ['p_server'], "the first player's services were disposed");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(changedTo, ['p_other'], 'the host hears the change once the services stopped');
  assert.deepEqual(
    await gated.client.purchase({ productId: 'REMOVE_ADS', source: 'shop', idempotencyKey: 'k4' }),
    {
      status: 'failed',
      purchase: {
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: gameServicesPlayerChangedCode, retryable: true },
      },
    },
  );
  assert.deepEqual(purchases, ['p_server:REMOVE_ADS'], 'no purchase reached the closed services');
  assert.equal(gated.monetizationRecovery, undefined, 'recovery is gone');
  assert.equal(gated.accountDeletion, undefined, 'Delete account is gone');
  assert.equal(gated.client.commerceReconciler, undefined);
  assert.equal(await gated.ensureSession?.(), false);
  await assert.rejects(
    gated.client.submitLeaderboardScore({} as never),
    StarterSessionRequiredError,
  );
  notify?.('p_third');
  assert.deepEqual(changedTo, ['p_other'], 'reported once');
  await gated.dispose();
  assert.deepEqual(disposed, ['p_server', 'p_server'], 'dispose reaches the inner services');
}

// dispose() closes services that never came up, so a late sign-in creates nothing.
{
  const created: string[] = [];
  let notify: ((playerId: string) => void) | undefined;
  const gated = createSessionGatedGameServices({
    probe: {
      mode: 'disabled',
      reason: 'missing_authoritative_backend',
      dispose: async () => undefined,
    },
    ensurePlayer: async () => undefined,
    onPlayer: (listener) => {
      notify = listener;
      return () => undefined;
    },
    create: (playerId) => {
      created.push(playerId);
      return {
        mode: 'disabled',
        reason: 'missing_authoritative_backend',
        dispose: async () => undefined,
      };
    },
    warn,
  });
  await gated.dispose();
  notify?.('p_late');
  assert.deepEqual(created, []);
}

// Services that cannot be created after sign-in stay gated with the stable error.
{
  const gated = createSessionGatedGameServices({
    probe: {
      mode: 'http',
      dispose: async () => undefined,
      client: {
        async purchase() {
          return { status: 'granted' } as never;
        },
        async claimRewardedAd() {
          return { status: 'granted' } as never;
        },
        async submitLeaderboardScore() {
          return { submitted: true } as never;
        },
      },
    },
    ensurePlayer: async () => 'p_broken',
    onPlayer: () => () => undefined,
    create: () => {
      throw new Error('storage unavailable');
    },
    warn,
  });
  assert.equal(
    (await gated.client?.purchase({ productId: 'REMOVE_ADS', source: 'shop', idempotencyKey: 'k3' }))?.status,
    'failed',
  );
  assert.match(warnings.at(-1) ?? '', /could not be created/u);
}

// A throwing activation callback does not undo the services it followed.
{
  let notify: ((playerId: string) => void) | undefined;
  const gated = createSessionGatedGameServices({
    probe: {
      mode: 'disabled',
      reason: 'missing_authoritative_backend',
      dispose: async () => undefined,
    },
    ensurePlayer: async () => undefined,
    onPlayer: (listener) => {
      notify = listener;
      return () => undefined;
    },
    create: () => ({ mode: 'http', dispose: async () => undefined }),
    onActivated: () => {
      throw new Error('reconcile wiring failed');
    },
    warn,
  });
  notify?.('p_up');
  assert.equal(gated.mode, 'http', 'the services are up');
  assert.match(warnings.at(-1) ?? '', /activation callback failed/u);
}

// A background sign-in brings the services up without any call from the game.
{
  const created: string[] = [];
  let notify: ((playerId: string) => void) | undefined;
  const gated = createSessionGatedGameServices({
    probe: {
      mode: 'disabled',
      reason: 'missing_authoritative_backend',
      dispose: async () => undefined,
    },
    ensurePlayer: async () => undefined,
    onPlayer: (listener) => {
      notify = listener;
      return () => undefined;
    },
    create: (playerId) => {
      created.push(playerId);
      return {
        mode: 'disabled',
        reason: 'missing_authoritative_backend',
        dispose: async () => undefined,
      };
    },
    warn,
  });
  assert.equal(gated.client, undefined, 'a disabled configuration has no client to gate');
  assert.equal(gated.ensureSession, undefined, 'and nothing a sign-in could bring up');
  notify?.('p_background');
  assert.deepEqual(created, ['p_background']);
  assert.equal(gated.reason, 'missing_authoritative_backend');
}

// Services bound to the session's player close once it names another one, then the host restarts.
{
  let current: { playerId: string } | undefined = { playerId: 'p_a' };
  const listeners = new Set<(session: { readonly playerId: string }) => void>();
  const session = {
    current: () => current,
    onAuthenticated(listener: (session: { readonly playerId: string }) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const announce = (playerId: string) => {
    current = { playerId };
    for (const listener of [...listeners]) {
      listener({ playerId });
    }
  };
  const order: string[] = [];
  const bound = bindStarterServicesToPlayer({
    services: {
      mode: 'http',
      async dispose() {
        order.push('disposed');
      },
    },
    playerId: 'p_a',
    session,
    onPlayerChanged: (playerId) => order.push(`restart:${playerId}`),
    warn,
  });
  announce('p_a');
  assert.deepEqual(order, [], 'a refresh of the same player changes nothing');
  announce('p_b');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['disposed', 'restart:p_b'], 'closed first, then the host restarts');
  assert.equal(listeners.size, 0, 'stops watching after the change');
  announce('p_c');
  assert.deepEqual(order, ['disposed', 'restart:p_b'], 'reported once');
  await bound.dispose();
  assert.deepEqual(order, ['disposed', 'restart:p_b', 'disposed']);

  // Created for another player than the session's (a local placeholder): it says so.
  const before = warnings.length;
  bindStarterServicesToPlayer({
    services: { mode: 'http', dispose: async () => undefined },
    playerId: 'android-local-player',
    session,
    warn,
  });
  assert.equal(warnings.length, before + 1);
  assert.match(warnings.at(-1) ?? '', /not the server session's/u);
}

setStarterCommerceServerPlayer(undefined);
console.info('Template guest identity passed.');
