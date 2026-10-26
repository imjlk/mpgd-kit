import assert from 'node:assert/strict';

import { accountDeletionConfirmationMaxLength } from '@mpgd/game-services/account-deletion';
import type { ServerGuestSessionCredentials } from '@mpgd/game-services/guest-session';

import { deriveAppAccountToken, deriveObfuscatedAccountId } from './accountBinding.js';
import {
  createGuestIdentityService,
  defaultIdentityServiceConfig,
  type GuestIdentityService,
  type IdentityResult,
} from './identityService.js';
import type { IdentityStore } from './store.js';
import { hashToken } from './tokens.js';

const minute = 60 * 1000;
const day = 24 * 60 * minute;

/**
 * The guest identity behaviour every store must give the service: issue,
 * rotation inside a stable family, expiry, replay detection, the retry
 * grace, revocation, the per-installation limit, the account bindings, the
 * purge, and account deletion (confirmations and `deletePlayer`). `createStore` returns an empty store each call.
 */
export async function runGuestIdentityConformance(createStore: () => Promise<IdentityStore>): Promise<void> {
  const start = Date.parse('2030-01-01T00:00:00.000Z');

  async function setup() {
    let clock = start;
    const ended: string[] = [];
    const logs: string[] = [];
    const store = await createStore();
    const service = createGuestIdentityService({
      store,
      now: () => clock,
      endNotificationSession: async (sessionId) => {
        ended.push(sessionId);
      },
      log: (message) => logs.push(message),
    });
    return {
      service,
      store,
      ended,
      logs,
      advance(ms: number) {
        clock += ms;
      },
      now: () => clock,
    };
  }

  // Issue: a new player and family, opaque prefixed tokens, the family as the session id.
  {
    const { service } = await setup();
    const first = value(await service.issueGuest({ installationId: 'install-00000001' }));
    assert.match(first.serverUserId, /^p_[0-9a-f]{32}$/u);
    assert.match(first.sessionId, /^s_[0-9a-f]{32}$/u);
    assert.equal(first.sessionFamilyId, first.sessionId);
    assert.equal(first.identityLevel, 'guest');
    assert.match(first.accessToken, /^mpgd_at_[A-Za-z0-9_-]{43}$/u);
    assert.match(first.refreshToken, /^mpgd_rt_[A-Za-z0-9_-]{43}$/u);
    assert.equal(
      first.accessExpiresAt,
      new Date(start + defaultIdentityServiceConfig.accessTokenTtlMs).toISOString(),
    );
    const second = value(await service.issueGuest({ installationId: 'install-00000001' }));
    assert.notEqual(second.serverUserId, first.serverUserId);
    assert.notEqual(second.sessionFamilyId, first.sessionFamilyId);
    assert.deepEqual(await service.authenticate(`Bearer ${first.accessToken}`), {
      playerId: first.serverUserId,
      sessionId: first.sessionFamilyId,
      installationId: 'install-00000001',
      expiresAt: new Date(start + defaultIdentityServiceConfig.refreshIdleMs).toISOString(),
    });
    // The scheme is case-insensitive; anything else is no principal.
    assert.equal(
      (await service.authenticate(`bearer ${first.accessToken}`))?.playerId,
      first.serverUserId,
    );
    for (const header of [
      first.accessToken,
      `Bearer ${first.refreshToken}`,
      'Bearer mpgd_at_x',
      undefined,
      42,
    ]) {
      assert.equal(await service.authenticate(header), undefined);
    }
    for (const installationId of ['short', 'has space 0000', 'x'.repeat(129), undefined, 7]) {
      assert.deepEqual(await service.issueGuest({ installationId }), {
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
  }

  // Rotation keeps the player and the family; the refresh token is single use.
  {
    const { service, advance, ended } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-rotate-1' }));
    advance(10 * minute);
    const rotated = value(await service.refresh({ refreshToken: issued.refreshToken }));
    assert.equal(rotated.serverUserId, issued.serverUserId);
    assert.equal(rotated.sessionFamilyId, issued.sessionFamilyId);
    assert.equal(rotated.sessionId, issued.sessionId);
    assert.notEqual(rotated.refreshToken, issued.refreshToken);
    assert.notEqual(rotated.accessToken, issued.accessToken);
    // The family's end slides with each refresh.
    assert.equal(
      (await service.authenticate(`Bearer ${rotated.accessToken}`))?.expiresAt,
      new Date(start + 10 * minute + defaultIdentityServiceConfig.refreshIdleMs).toISOString(),
    );
    // The previous access token stays valid until it expires (a refresh ahead of expiry).
    assert.equal(
      (await service.authenticate(`Bearer ${issued.accessToken}`))?.playerId,
      issued.serverUserId,
    );
    advance(5 * minute);
    assert.equal(await service.authenticate(`Bearer ${issued.accessToken}`), undefined);
    assert.equal(
      (await service.authenticate(`Bearer ${rotated.accessToken}`))?.playerId,
      issued.serverUserId,
    );
    const again = value(await service.refresh({ refreshToken: rotated.refreshToken }));
    assert.equal(again.sessionFamilyId, issued.sessionFamilyId);
    assert.deepEqual(ended, []);
  }

  // Replay: an invalidated refresh token revokes the whole family (RFC 9700 4.14.2).
  {
    const { service, advance, ended, logs } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-replay-1' }));
    const rotated = value(await service.refresh({ refreshToken: issued.refreshToken }));
    advance(defaultIdentityServiceConfig.refreshRetryGraceMs + 1);
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    assert.deepEqual(ended, [issued.sessionFamilyId]);
    assert.equal(logs.length, 1);
    assert.equal(
      logs.some((line) => line.includes(issued.refreshToken)),
      false,
    );
    // Both parties are out: the current token and every access token of the family.
    assert.deepEqual(await service.refresh({ refreshToken: rotated.refreshToken }), rejected);
    assert.equal(await service.authenticate(`Bearer ${rotated.accessToken}`), undefined);
    assert.equal(await service.authenticate(`Bearer ${issued.accessToken}`), undefined);
    // A second replay changes nothing more.
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    assert.deepEqual(ended, [issued.sessionFamilyId]);
  }

  // An older token (two rotations back) is a replay too, even inside the grace window.
  {
    const { service, ended } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-replay-2' }));
    const second = value(await service.refresh({ refreshToken: issued.refreshToken }));
    const third = value(await service.refresh({ refreshToken: second.refreshToken }));
    assert.equal(
      (await service.authenticate(`Bearer ${third.accessToken}`))?.playerId,
      issued.serverUserId,
    );
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    assert.deepEqual(await service.refresh({ refreshToken: third.refreshToken }), rejected);
    // Every access token of the family ends with it, before its own expiry.
    assert.equal(await service.authenticate(`Bearer ${third.accessToken}`), undefined);
    assert.deepEqual(ended, [issued.sessionFamilyId]);
  }

  // Retry grace: a client that lost the rotation's answer retries the old
  // token while its successor is unused, and gets the same successor back.
  {
    const { service, advance, ended } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-retry-1' }));
    const lost = value(await service.refresh({ refreshToken: issued.refreshToken }));
    advance(minute);
    const retried = value(await service.refresh({ refreshToken: issued.refreshToken }));
    assert.equal(retried.sessionFamilyId, issued.sessionFamilyId);
    assert.equal(retried.refreshToken, lost.refreshToken);
    assert.notEqual(retried.accessToken, lost.accessToken);
    // No answer invalidates another: both access tokens work.
    for (const answer of [lost, retried]) {
      assert.equal(
        (await service.authenticate(`Bearer ${answer.accessToken}`))?.playerId,
        issued.serverUserId,
      );
    }
    // The window counts from the rotation: a later retry is a replay.
    advance(defaultIdentityServiceConfig.refreshRetryGraceMs - minute + 1);
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    assert.deepEqual(ended, [issued.sessionFamilyId]);
  }
  {
    // Once the successor was used, the replaced token is a replay, even inside the window.
    const { service, ended } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-retry-2' }));
    const second = value(await service.refresh({ refreshToken: issued.refreshToken }));
    value(await service.refresh({ refreshToken: second.refreshToken }));
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    assert.deepEqual(ended, [issued.sessionFamilyId]);
  }
  {
    // With the grace off, the first retry is a replay.
    const store = await createStore();
    const service = createGuestIdentityService({
      store,
      now: () => start,
      config: { refreshRetryGraceMs: 0 },
      log: () => undefined,
    });
    const issued = value(await service.issueGuest({ installationId: 'install-retry-3' }));
    value(await service.refresh({ refreshToken: issued.refreshToken }));
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
  }

  // Two refreshes racing with one token both get the same successor.
  {
    const { service } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-race-1' }));
    const answers = await Promise.all([
      service.refresh({ refreshToken: issued.refreshToken }),
      service.refresh({ refreshToken: issued.refreshToken }),
    ]);
    const [first, second] = answers.map(value);
    assert.equal(first?.refreshToken, second?.refreshToken);
    value(await service.refresh({ refreshToken: first?.refreshToken }));
  }

  // An abandoned request that finishes after its retry was answered never
  // invalidates the token the retry returned: the client timed out a refresh,
  // retried it, kept the retry's answer, and the first request's rotation
  // runs last (it loses the compare-and-swap and is answered as a retry).
  {
    const store = await createStore();
    let hold: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    const paused: IdentityStore = {
      ...store,
      async rotate(input) {
        if (hold !== undefined) {
          const wait = hold;
          hold = undefined;
          entered?.();
          await wait;
        }
        return store.rotate(input);
      },
    };
    const ended: string[] = [];
    const service = createGuestIdentityService({
      store: paused,
      now: () => start,
      endNotificationSession: async (sessionId) => {
        ended.push(sessionId);
      },
      log: () => undefined,
    });
    const issued = value(await service.issueGuest({ installationId: 'install-overlap-1' }));
    let release: (() => void) | undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredRotate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const abandoned = service.refresh({ refreshToken: issued.refreshToken });
    await enteredRotate;
    const kept = value(await service.refresh({ refreshToken: issued.refreshToken }));
    release?.();
    const late = value(await abandoned);
    assert.equal(late.refreshToken, kept.refreshToken);
    // The client's next refresh with the token it kept rotates normally.
    value(await service.refresh({ refreshToken: kept.refreshToken }));
    assert.deepEqual(ended, []);
  }

  // An abandoned refresh that resumes after the family moved on twice (A -> B by
  // its retry, B -> C by a later launch) lost a race; it is not a replay. The
  // family stays, nothing is revoked, and the abandoned request is told to retry.
  {
    const store = await createStore();
    let hold: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    const paused: IdentityStore = {
      ...store,
      async rotate(input) {
        if (hold !== undefined) {
          const wait = hold;
          hold = undefined;
          entered?.();
          await wait;
        }
        return store.rotate(input);
      },
    };
    const ended: string[] = [];
    const service = createGuestIdentityService({
      store: paused,
      now: () => start,
      endNotificationSession: async (sessionId) => {
        ended.push(sessionId);
      },
      log: () => undefined,
    });
    const issued = value(await service.issueGuest({ installationId: 'install-overlap-2' }));
    let release: (() => void) | undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredRotate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const abandoned = service.refresh({ refreshToken: issued.refreshToken });
    await enteredRotate;
    const second = value(await service.refresh({ refreshToken: issued.refreshToken }));
    const third = value(await service.refresh({ refreshToken: second.refreshToken }));
    release?.();
    assert.deepEqual(await abandoned, { ok: false, error: 'UNAVAILABLE' });
    assert.deepEqual(ended, [], 'the family was not revoked');
    assert.equal(
      (await service.authenticate(`Bearer ${third.accessToken}`))?.playerId,
      issued.serverUserId,
    );
    value(await service.refresh({ refreshToken: third.refreshToken }));
    // Real replay detection is intact: the same old token presented afresh revokes.
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    assert.deepEqual(ended, [issued.sessionFamilyId]);
  }

  // The same race on the retry path: an abandoned retry of the replaced token A
  // (successor B unused at its read) resumes after B -> C. Not a replay either.
  {
    const store = await createStore();
    let hold: Promise<void> | undefined;
    let entered: (() => void) | undefined;
    const paused: IdentityStore = {
      ...store,
      async addAccessToken(input) {
        if (hold !== undefined) {
          const wait = hold;
          hold = undefined;
          entered?.();
          await wait;
        }
        return store.addAccessToken(input);
      },
    };
    const ended: string[] = [];
    const service = createGuestIdentityService({
      store: paused,
      now: () => start,
      endNotificationSession: async (sessionId) => {
        ended.push(sessionId);
      },
      log: () => undefined,
    });
    const issued = value(await service.issueGuest({ installationId: 'install-overlap-3' }));
    const second = value(await service.refresh({ refreshToken: issued.refreshToken }));
    let release: (() => void) | undefined;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredAdd = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const abandonedRetry = service.refresh({ refreshToken: issued.refreshToken });
    await enteredAdd;
    const third = value(await service.refresh({ refreshToken: second.refreshToken }));
    release?.();
    assert.deepEqual(await abandonedRetry, { ok: false, error: 'UNAVAILABLE' });
    assert.deepEqual(ended, []);
    value(await service.refresh({ refreshToken: third.refreshToken }));
  }

  // Both rounds lose: the abandoned refresh of A loses its rotation to a retry
  // (A -> B), re-reads A as a valid retry, and then loses that too to B -> C.
  {
    const store = await createStore();
    const holds: { rotate?: Promise<void> | undefined; add?: Promise<void> | undefined } = {};
    const entered: { rotate?: () => void; add?: () => void } = {};
    const paused: IdentityStore = {
      ...store,
      async rotate(input) {
        const wait = holds.rotate;
        if (wait !== undefined) {
          holds.rotate = undefined;
          entered.rotate?.();
          await wait;
        }
        return store.rotate(input);
      },
      async addAccessToken(input) {
        const wait = holds.add;
        if (wait !== undefined) {
          holds.add = undefined;
          entered.add?.();
          await wait;
        }
        return store.addAccessToken(input);
      },
    };
    const ended: string[] = [];
    const service = createGuestIdentityService({
      store: paused,
      now: () => start,
      endNotificationSession: async (sessionId) => {
        ended.push(sessionId);
      },
      log: () => undefined,
    });
    const issued = value(await service.issueGuest({ installationId: 'install-overlap-4' }));
    let releaseRotate: (() => void) | undefined;
    let releaseAdd: (() => void) | undefined;
    holds.rotate = new Promise<void>((resolve) => {
      releaseRotate = resolve;
    });
    const enteredRotate = new Promise<void>((resolve) => {
      entered.rotate = resolve;
    });
    const abandoned = service.refresh({ refreshToken: issued.refreshToken });
    await enteredRotate;
    const second = value(await service.refresh({ refreshToken: issued.refreshToken }));
    holds.add = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const enteredAdd = new Promise<void>((resolve) => {
      entered.add = resolve;
    });
    releaseRotate?.();
    await enteredAdd;
    const third = value(await service.refresh({ refreshToken: second.refreshToken }));
    releaseAdd?.();
    assert.deepEqual(await abandoned, { ok: false, error: 'UNAVAILABLE' });
    assert.deepEqual(ended, []);
    value(await service.refresh({ refreshToken: third.refreshToken }));
  }

  // Expiry: access tokens after their lifetime, families after the inactivity window.
  {
    const { service, advance } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-expiry-1' }));
    advance(defaultIdentityServiceConfig.accessTokenTtlMs);
    assert.equal(await service.authenticate(`Bearer ${issued.accessToken}`), undefined);
    advance(
      defaultIdentityServiceConfig.refreshIdleMs - defaultIdentityServiceConfig.accessTokenTtlMs - 1,
    );
    const kept = value(await service.refresh({ refreshToken: issued.refreshToken }));
    advance(defaultIdentityServiceConfig.refreshIdleMs);
    assert.deepEqual(await service.refresh({ refreshToken: kept.refreshToken }), rejected);
  }

  // Logout revokes the family, once; unknown and malformed tokens are not errors.
  {
    const { service, ended } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-logout-1' }));
    const rotated = value(await service.refresh({ refreshToken: issued.refreshToken }));
    await service.revoke({ refreshToken: rotated.refreshToken });
    assert.deepEqual(ended, [issued.sessionFamilyId]);
    assert.equal(await service.authenticate(`Bearer ${rotated.accessToken}`), undefined);
    assert.deepEqual(await service.refresh({ refreshToken: rotated.refreshToken }), rejected);
    // A repeated logout sends the end again (a retry for a missed one); unknown tokens send nothing.
    await service.revoke({ refreshToken: rotated.refreshToken });
    await service.revoke({ refreshToken: 'mpgd_rt_' + 'A'.repeat(43) });
    await service.revoke({ refreshToken: 'nope' });
    await service.revoke({ refreshToken: undefined });
    assert.deepEqual(ended, [issued.sessionFamilyId, issued.sessionFamilyId]);
    for (const refreshToken of ['nope', undefined, 'mpgd_rt_' + 'A'.repeat(43)]) {
      assert.deepEqual(await service.refresh({ refreshToken }), rejected);
    }
  }

  // A failed endNotificationSession is logged, and the revocation still holds.
  {
    const store = await createStore();
    const logs: string[] = [];
    const service = createGuestIdentityService({
      store,
      now: () => start,
      endNotificationSession: async () => {
        throw new TypeError('binding down');
      },
      log: (message) => logs.push(message),
    });
    const issued = value(await service.issueGuest({ installationId: 'install-logout-2' }));
    await service.revoke({ refreshToken: issued.refreshToken });
    assert.deepEqual(logs, ['[identity] endNotificationSession failed: TypeError']);
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
  }

  // At most five guests per installation in a rolling day.
  {
    const { service, advance } = await setup();
    for (let index = 0; index < defaultIdentityServiceConfig.maxGuestsPerInstallationPerDay; index += 1) {
      value(await service.issueGuest({ installationId: 'install-limit-1' }));
    }
    assert.deepEqual(await service.issueGuest({ installationId: 'install-limit-1' }), {
      ok: false,
      error: 'RATE_LIMITED',
    });
    value(await service.issueGuest({ installationId: 'install-limit-2' }));
    advance(day);
    value(await service.issueGuest({ installationId: 'install-limit-1' }));
    // Concurrent requests cannot all pass the limit: it is checked in the same step as the write.
    const limit = defaultIdentityServiceConfig.maxGuestsPerInstallationPerDay;
    const burst = await Promise.all(
      Array.from({ length: limit + 3 }, () =>
        service.issueGuest({ installationId: 'install-limit-3' }),
      ),
    );
    assert.equal(burst.filter((answer) => answer.ok).length, limit);
    assert.equal(burst.filter((answer) => !answer.ok && answer.error === 'RATE_LIMITED').length, 3);
  }

  // Account binding is the seam for later, not a provider login.
  {
    const { service } = await setup();
    assert.deepEqual(
      await service.bindAccount({ refreshToken: 'x', externalProof: 'y', idempotencyKey: 'z' }),
      {
        ok: false,
        error: 'ACCOUNT_BINDING_UNSUPPORTED',
      },
    );
  }

  // Store account bindings: only for a player this service issued.
  {
    const { service } = await setup();
    const issued = value(await service.issueGuest({ installationId: 'install-binding-1' }));
    assert.equal(
      await service.resolveObfuscatedAccountId(issued.serverUserId),
      await deriveObfuscatedAccountId(issued.serverUserId),
    );
    assert.equal(
      await service.resolveAppAccountToken(issued.serverUserId),
      await deriveAppAccountToken(issued.serverUserId),
    );
    for (const playerId of [`p_${'0'.repeat(32)}`, 'android-local-player', '', undefined]) {
      assert.equal(await service.resolveObfuscatedAccountId(playerId), undefined);
      assert.equal(await service.resolveAppAccountToken(playerId), undefined);
    }
  }

  // Purge: ended families and their tokens go; live ones and players stay.
  {
    const { service, store, advance } = await setup();
    const kept = value(await service.issueGuest({ installationId: 'install-purge-1' }));
    const revoked = value(await service.issueGuest({ installationId: 'install-purge-2' }));
    const idle = value(await service.issueGuest({ installationId: 'install-purge-4' }));
    await service.revoke({ refreshToken: revoked.refreshToken });
    // Keep `kept` alive past the inactivity window; `idle` lapses.
    advance(defaultIdentityServiceConfig.refreshIdleMs - day);
    const kept2 = value(await service.refresh({ refreshToken: kept.refreshToken }));
    // `idle` ended a day later; the purge keeps ended families 7 days for support.
    advance(9 * day);
    await service.purge();
    assert.equal(await store.getFamily(revoked.sessionId), undefined);
    assert.equal(await store.getFamily(idle.sessionId), undefined);
    assert.equal(await store.findRefreshToken(await hashToken(idle.refreshToken)), undefined);
    assert.notEqual(await store.getFamily(kept.sessionId), undefined);
    const rotated = value(await service.refresh({ refreshToken: kept2.refreshToken }));
    await service.purge();
    assert.equal(
      (await service.authenticate(`Bearer ${rotated.accessToken}`))?.playerId,
      kept.serverUserId,
    );
    value(await service.refresh({ refreshToken: rotated.refreshToken }));
    // The revoked family is gone: its token is now unknown, still rejected.
    assert.deepEqual(await service.refresh({ refreshToken: revoked.refreshToken }), rejected);
    assert.equal(
      await service.resolveObfuscatedAccountId(revoked.serverUserId),
      await deriveObfuscatedAccountId(revoked.serverUserId),
    );
  }

  // A shorter inactivity window later never purges a token a live family still holds.
  {
    const store = await createStore();
    let clock = start;
    const longWindow = createGuestIdentityService({
      store,
      now: () => clock,
      log: () => undefined,
    });
    const issued = value(await longWindow.issueGuest({ installationId: 'install-purge-3' }));
    const rotated = value(await longWindow.refresh({ refreshToken: issued.refreshToken }));
    clock += 100 * day;
    const shortWindow = createGuestIdentityService({
      store,
      now: () => clock,
      config: { refreshIdleMs: 30 * day, refreshRetryGraceMs: day },
      log: () => undefined,
    });
    await shortWindow.purge();
    // The family (issued under 180 days) is still live; its current token survived the purge.
    value(await shortWindow.refresh({ refreshToken: rotated.refreshToken }));
  }

  // The purge does remove an old token no family holds: it is unknown afterwards, not a replay.
  {
    const store = await createStore();
    let clock = start;
    const ended: string[] = [];
    const service = createGuestIdentityService({
      store,
      now: () => clock,
      endNotificationSession: async (sessionId) => {
        ended.push(sessionId);
      },
      log: () => undefined,
    });
    const issued = value(await service.issueGuest({ installationId: 'install-purge-5' }));
    const second = value(await service.refresh({ refreshToken: issued.refreshToken }));
    clock += 170 * day;
    const third = value(await service.refresh({ refreshToken: second.refreshToken }));
    clock += 20 * day;
    // The first token (issued 190 days ago) is neither current nor previous, so it goes.
    await service.purge();
    assert.equal(await store.findRefreshToken(await hashToken(issued.refreshToken)), undefined);
    assert.notEqual(await store.findRefreshToken(await hashToken(second.refreshToken)), undefined);
    assert.deepEqual(await service.refresh({ refreshToken: issued.refreshToken }), rejected);
    // Unknown, so not a replay: the family lives on.
    assert.deepEqual(ended, []);
    value(await service.refresh({ refreshToken: third.refreshToken }));
  }

  // Account deletion (L3b): a confirmation takes the refresh token (an access
  // token is not enough), is bound to its player, short-lived, and used once.
  {
    const { service, store, advance, ended, now } = await setup();
    const guest = value(await service.issueGuest({ installationId: 'install-delete-1' }));
    const other = value(await service.issueGuest({ installationId: 'install-delete-2' }));
    const confirm = (refreshToken: unknown) => service.issueAccountDeletionConfirmation({
      refreshToken,
    });
    const verify = async (playerId: unknown, confirmation: unknown) =>
      (await service.verifyAccountDeletionConfirmation({ playerId, confirmation })).confirmed;
    assert.deepEqual(await confirm(guest.accessToken), rejected);
    assert.deepEqual(await confirm(`mpgd_rt_${'A'.repeat(43)}`), rejected);
    assert.deepEqual(await confirm(undefined), rejected);
    const first = grant(await confirm(guest.refreshToken));
    assert.match(first.confirmation, /^mpgd_dc_[A-Za-z0-9_-]{43}$/u);
    assert.ok(first.confirmation.length <= accountDeletionConfirmationMaxLength);
    assert.equal(
      first.expiresAt,
      new Date(now() + defaultIdentityServiceConfig.accountDeletionConfirmationTtlMs).toISOString(),
    );
    // Another player's attempt, a forged or malformed one: refused, and nothing used up.
    assert.equal(await verify(other.serverUserId, first.confirmation), false);
    assert.equal(await verify(guest.serverUserId, `mpgd_dc_${'A'.repeat(43)}`), false);
    assert.equal(await verify(guest.serverUserId, 42), false);
    assert.equal(await verify(42, first.confirmation), false);
    const survivor = grant(await confirm(other.refreshToken));
    assert.equal(await verify(guest.serverUserId, survivor.confirmation), false);
    assert.equal(await verify(other.serverUserId, survivor.confirmation), true, 'left usable');
    // A new confirmation replaces the family's earlier one; each confirms once.
    const second = grant(await confirm(guest.refreshToken));
    assert.equal(await verify(guest.serverUserId, first.confirmation), false);
    assert.equal(await verify(guest.serverUserId, second.confirmation), true);
    assert.equal(await verify(guest.serverUserId, second.confirmation), false);
    // Short-lived.
    const late = grant(await confirm(guest.refreshToken));
    advance(defaultIdentityServiceConfig.accountDeletionConfirmationTtlMs);
    assert.equal(await verify(guest.serverUserId, late.confirmation), false);
    // Issuing does not rotate; inside the retry grace the replaced token also
    // gets one, and once its successor was used it is refused without a revoke.
    const rotated = value(await service.refresh({ refreshToken: guest.refreshToken }));
    grant(await confirm(guest.refreshToken));
    const current = value(await service.refresh({ refreshToken: rotated.refreshToken }));
    assert.deepEqual(await confirm(guest.refreshToken), rejected);
    assert.equal(
      (await service.authenticate(`Bearer ${current.accessToken}`))?.playerId,
      guest.serverUserId,
    );
    // A family that logged out keeps no confirmation and gets none.
    const loggedOut = grant(await confirm(other.refreshToken));
    await service.revoke({ refreshToken: other.refreshToken });
    assert.equal(await verify(other.serverUserId, loggedOut.confirmation), false);
    assert.deepEqual(await confirm(other.refreshToken), rejected);
    ended.length = 0;

    // Deleting the player refuses every token at once, on every path.
    const pending = grant(await confirm(current.refreshToken));
    const kept = value(await service.issueGuest({ installationId: 'install-delete-3' }));
    await service.deletePlayer({ playerId: guest.serverUserId });
    await service.deletePlayer({ playerId: guest.serverUserId });
    await service.deletePlayer({ playerId: `p_${'0'.repeat(32)}` });
    await assert.rejects(service.deletePlayer({ playerId: 42 }), TypeError);
    assert.equal(await service.authenticate(`Bearer ${current.accessToken}`), undefined);
    assert.deepEqual(await service.refresh({ refreshToken: current.refreshToken }), rejected);
    // The replaced token, still inside the retry grace, and the first one.
    assert.deepEqual(await service.refresh({ refreshToken: rotated.refreshToken }), rejected);
    assert.deepEqual(await service.refresh({ refreshToken: guest.refreshToken }), rejected);
    assert.deepEqual(await confirm(current.refreshToken), rejected);
    assert.equal(await verify(guest.serverUserId, pending.confirmation), false);
    assert.equal(await service.resolveObfuscatedAccountId(guest.serverUserId), undefined);
    assert.equal(await service.resolveAppAccountToken(guest.serverUserId), undefined);
    await service.revoke({ refreshToken: current.refreshToken });
    assert.equal(await store.hasPlayer(guest.serverUserId), false);
    assert.equal(await store.getFamily(guest.sessionId), undefined);
    for (const token of [guest.refreshToken, rotated.refreshToken, current.refreshToken]) {
      assert.equal(await store.findRefreshToken(await hashToken(token)), undefined);
    }
    // Unknown tokens, not replays: nothing else was revoked or ended.
    assert.deepEqual(ended, []);
    assert.equal(
      (await service.authenticate(`Bearer ${kept.accessToken}`))?.playerId,
      kept.serverUserId,
    );
    value(await service.refresh({ refreshToken: kept.refreshToken }));

    // A rotation, a retry's access token, or a confirmation racing the deletion writes nothing.
    const racing = value(await service.issueGuest({ installationId: 'install-delete-4' }));
    const family = await store.getFamily(racing.sessionId);
    assert.ok(family !== undefined);
    await service.deletePlayer({ playerId: racing.serverUserId });
    const access = {
      tokenHash: await hashToken('racing-access'),
      familyId: family.familyId,
      playerId: family.playerId,
      expiresAt: now() + minute,
    };
    assert.equal(
      await store.rotate({
        familyId: family.familyId,
        now: now(),
        expected: { currentRefreshHash: family.currentRefreshHash },
        next: {
          currentRefreshHash: await hashToken('racing-refresh'),
          previousRefreshHash: family.currentRefreshHash,
          rotatedAt: now(),
          expiresAt: now() + day,
          rotationNonce: 'nonce',
        },
        access,
      }),
      false,
    );
    assert.equal(
      await store.addAccessToken({ now: now(), currentRefreshHash: family.currentRefreshHash, access }),
      false,
    );
    assert.equal(
      await store.putDeletionConfirmation({
        confirmation: {
          tokenHash: await hashToken('racing-confirmation'),
          familyId: family.familyId,
          playerId: family.playerId,
          expiresAt: now() + minute,
        },
        now: now(),
      }),
      false,
    );
    assert.equal(await store.findAccessToken(access.tokenHash), undefined);
    assert.equal(await store.findRefreshToken(await hashToken('racing-refresh')), undefined);
    assert.equal(await store.getFamily(family.familyId), undefined);
  }

  // A confirmation survives a rotation of its family; a replay revoke, or
  // the family's idle end, refuses it.
  {
    const { service } = await setup();
    const verify = async (playerId: string, confirmation: string) =>
      (await service.verifyAccountDeletionConfirmation({ playerId, confirmation })).confirmed;
    const guest = value(await service.issueGuest({ installationId: 'install-delete-5' }));
    const kept = grant(
      await service.issueAccountDeletionConfirmation({ refreshToken: guest.refreshToken }),
    );
    const second = value(await service.refresh({ refreshToken: guest.refreshToken }));
    assert.equal(await verify(guest.serverUserId, kept.confirmation), true);
    const pending = grant(
      await service.issueAccountDeletionConfirmation({ refreshToken: second.refreshToken }),
    );
    value(await service.refresh({ refreshToken: second.refreshToken }));
    // The first token is neither current nor the replaced one: a replay, which revokes.
    assert.deepEqual(await service.refresh({ refreshToken: guest.refreshToken }), rejected);
    assert.equal(await verify(guest.serverUserId, pending.confirmation), false);
  }
  {
    let clock = start;
    const service = createGuestIdentityService({
      store: await createStore(),
      now: () => clock,
      config: {
        accessTokenTtlMs: minute,
        refreshIdleMs: 10 * minute,
        refreshRetryGraceMs: 0,
        accountDeletionConfirmationTtlMs: 60 * minute,
      },
      log: () => undefined,
    });
    const guest = value(await service.issueGuest({ installationId: 'install-delete-6' }));
    const idle = grant(
      await service.issueAccountDeletionConfirmation({ refreshToken: guest.refreshToken }),
    );
    clock += 10 * minute;
    assert.deepEqual(
      await service.verifyAccountDeletionConfirmation({ playerId: guest.serverUserId, confirmation: idle.confirmation }),
      { confirmed: false },
    );
    // The purge removes expired confirmations (the D1 test counts the rows).
    clock += 60 * minute;
    await service.purge();
  }

  // Configuration that cannot work is refused.
  assert.throws(
    () =>
      createGuestIdentityService({ store: {} as IdentityStore, config: { accessTokenTtlMs: 0 } }),
    /Identity config/u,
  );
  assert.throws(
    () =>
      createGuestIdentityService({
        store: {} as IdentityStore,
        config: { refreshRetryGraceMs: 200 * day },
      }),
    /Identity config/u,
  );
}

const rejected = { ok: false, error: 'GUEST_SESSION_REJECTED' };

function grant<T>(result: IdentityResult<T>): T {
  assert.ok(result.ok, `expected a confirmation, got ${JSON.stringify(result)}`);
  return result.value;
}

function value(result: IdentityResult<ServerGuestSessionCredentials>): ServerGuestSessionCredentials {
  if (!result.ok) {
    throw new Error(`Expected credentials, got ${result.error}.`);
  }
  return result.value;
}

export type { GuestIdentityService };
