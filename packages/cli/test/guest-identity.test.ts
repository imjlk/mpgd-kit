import assert from 'node:assert/strict';

import {
  GuestSessionRejectedError,
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
  starterInstallationIdKey,
  startStarterGuestIdentity,
} from '../templates/phaser-game/src/platform/guestIdentity.js';

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

setStarterCommerceServerPlayer(undefined);
console.info('Template guest identity passed.');
