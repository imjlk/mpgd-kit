import {
  formatNotificationInstant,
  notificationSendDueAt,
  type NotificationHistoryEntry,
  type NotificationNoticeGiven,
  type NotificationPlatformRegistration,
  type NotificationStore,
  type NotificationStoredEndpoint,
  type NotificationStoredSend,
  type NotificationVersionedSend,
} from '@mpgd/game-services/notifications';
import type { NotificationConsentRecord } from '@mpgd/platform/notifications';
import { createHash } from 'node:crypto';

/**
 * A `NotificationStore` over Devvit Redis (notifications v2 RFC, "Delivery
 * providers", Devvit: "The same delivery module and policy gate run there
 * with a Redis-backed ledger"). The notifications service of
 * `@mpgd/game-services/notifications` keeps every rule; this store keeps the
 * rows and answers each atomic step with one WATCH/MULTI/EXEC transaction.
 *
 * - **Sends** (the claim/lease ledger) are one JSON value per key with a
 *   version token. `updateSend` writes only while the stored version is the
 *   one the caller read, inside a transaction that watches the key, so a
 *   holder whose lease another worker took over cannot write its answer
 *   back. The due, in-flight, and retention indexes are sorted sets written
 *   in the same transaction as the value, so they never disagree with it.
 * - **Consent records** are a sorted set per player scored by the record's
 *   millisecond; an append watches it, so parallel appends each take their
 *   own millisecond.
 * - **Device endpoints** are one JSON value per provider and installation,
 *   with an address pointer per provider and address (the uniqueness check)
 *   and sorted-set indexes per player, session, and installation, all
 *   written in the endpoint's own transaction. A call reads and watches only
 *   the keys of the endpoints it touches, so reads and contention scale with
 *   one player's endpoints. `purge` reads, per cutoff, only the endpoints
 *   past it from a time index. The address pointer's key holds a hash of
 *   the address, so a device token never appears in a key name. Updates
 *   to several endpoints (a session's) commit one endpoint at a time. A
 *   Devvit server serves only platform-user
 *   providers, so it stores none in practice.
 * - **History** is a hash per player (one field per send and provider, so a
 *   repeat is ignored) with a sorted set by time.
 * - **Order.** Lists come sorted (by time, then by key or installation),
 *   not in insertion order as in the in-memory store; the interface promises
 *   only "oldest first" and "earliest first", and the service sorts where
 *   it needs more.
 * - **Purge** deletes every row past its cutoff, as the interface says; a
 *   deployment that bounds each call sets `purgeLimit`, and the next
 *   scheduled purge continues.
 *
 * The Devvit Redis client (`@devvit/redis` `TxClient.exec()`) resolves an
 * aborted transaction as an empty array, never `null`, so a result shorter
 * than the commands queued would be a conflict in
 * `createDevvitRedisPostOperationStore`. Here every transaction ends with a
 * commit marker whose reply always maps, so only an empty or all-nil result
 * is an abort, and a committed write is never retried as if it were lost.
 * Devvit allows 20 concurrent transactions per installation by default.
 *
 * Devvit Redis: <https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/server/redis>
 * (transactions: WATCH, MULTI, EXEC, DISCARD, UNWATCH).
 */

/** The member and score of a sorted-set entry, as `@devvit/redis` reads and writes them. */
export interface DevvitNotificationRedisMember {
  readonly member: string;
  readonly score: number;
}

/** The commands this store queues inside a transaction (`@devvit/redis` `TxClientLike`). */
export interface DevvitNotificationRedisTransaction {
  multi(): Promise<unknown>;
  exec(): Promise<readonly unknown[] | null>;
  discard(): Promise<unknown>;
  unwatch(): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<unknown>;
  hDel(key: string, fields: string[]): Promise<unknown>;
  zAdd(key: string, ...members: DevvitNotificationRedisMember[]): Promise<unknown>;
  zRem(key: string, members: string[]): Promise<unknown>;
}

/** The subset of the Devvit server Redis client (`redis` from `@devvit/web/server`) this store reads. */
export interface DevvitNotificationRedis {
  get(key: string): Promise<string | undefined>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hMGet(key: string, fields: string[]): Promise<(string | null)[]>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<unknown>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    options?: {
      readonly by: 'score' | 'lex' | 'rank';
      readonly limit?: { readonly offset: number; readonly count: number };
    },
  ): Promise<{ member: string; score: number }[]>;
  watch(...keys: string[]): Promise<DevvitNotificationRedisTransaction>;
}

export interface CreateDevvitRedisNotificationStoreOptions {
  /** Prefix of every key; generated games pass their game name. Default `mpgd:notifications`. */
  readonly namespace?: string;
  /** Attempts of one atomic step before it fails as contended; 16 by default, at most 64. */
  readonly transactionAttempts?: number;
  /** A fresh send version token; random by default. */
  readonly newVersion?: () => string;
  /**
   * Waits before an aborted step is planned again, `attempt` from 1; a
   * short jittered backoff by default, so contending writers spread out
   * instead of retrying in lockstep.
   */
  readonly backoff?: (attempt: number) => Promise<void>;
  /**
   * Sends, history rows, and endpoints (per cutoff) one `purge` call deletes at most, each; unbounded
   * by default, as `NotificationStore.purge` deletes every row past its
   * cutoff. Each row costs a few Redis round trips, so a deployment whose
   * purge runs in a time-bounded Devvit request or scheduler job sets it
   * (say 500) and runs the purge again while a count equals it.
   */
  readonly purgeLimit?: number;
}

export const defaultDevvitNotificationNamespace = 'mpgd:notifications';
const defaultTransactionAttempts = 16;
const maximumTransactionAttempts = 64;
const defaultPurgeLimit = Number.POSITIVE_INFINITY;
/** The commit marker's value; its SET replies `OK`, which `@devvit/redis` always maps. */
const commitMarkerValue = '1';
/** Sorted-set page size; `@devvit/redis` reads at most 1,000 members per score or lex range. */
const pageSize = 500;

/** A transaction's plan: commands and the step's answer, or `retry` when its preparing read is outdated. */
type Plan<Result> =
  | { readonly commands: readonly Command[]; readonly result: Result }
  | { readonly retry: true };

/** A queued command; each queues exactly one command after MULTI. */
type Command = (transaction: DevvitNotificationRedisTransaction) => Promise<unknown>;

interface StoredSendValue {
  readonly send: NotificationStoredSend;
  readonly version: string;
}

export function createDevvitRedisNotificationStore(
  redis: DevvitNotificationRedis,
  options: CreateDevvitRedisNotificationStoreOptions = {},
): NotificationStore {
  const namespace = options.namespace ?? defaultDevvitNotificationNamespace;
  if (namespace.length === 0) {
    throw new TypeError('The Devvit notification store namespace must not be empty.');
  }
  const attempts = options.transactionAttempts ?? defaultTransactionAttempts;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > maximumTransactionAttempts) {
    throw new TypeError(
      `transactionAttempts must be a safe integer from 1 to ${String(maximumTransactionAttempts)}.`,
    );
  }
  const newVersion = options.newVersion ?? (() => globalThis.crypto.randomUUID());
  const backoff = options.backoff ?? defaultBackoff;
  const purgeLimit = options.purgeLimit ?? defaultPurgeLimit;
  if (purgeLimit !== defaultPurgeLimit && (!Number.isSafeInteger(purgeLimit) || purgeLimit < 1)) {
    throw new TypeError('purgeLimit must be a positive safe integer.');
  }
  const enc = encodeURIComponent;
  const keys = {
    consent: (player: string) => `${namespace}:consent:${enc(player)}`,
    endpoint: (provider: string, installationId: string) =>
      `${namespace}:endpoint:${enc(provider)}:${enc(installationId)}`,
    // The address is hashed: a device token never appears in a key name.
    endpointAddress: (provider: string, value: string) =>
      `${namespace}:endpoint-address:${enc(provider)}:${createHash('sha256').update(value).digest('hex')}`,
    endpointsByPlayer: (player: string) => `${namespace}:endpoints-player:${enc(player)}`,
    endpointsBySession: (sessionId: string) => `${namespace}:endpoints-session:${enc(sessionId)}`,
    endpointsByInstallation: (installationId: string) =>
      `${namespace}:endpoints-installation:${enc(installationId)}`,
    endpointsRegistered: `${namespace}:endpoints-registered`,
    endpointsInvalidated: `${namespace}:endpoints-invalidated`,
    endpointsSessionEnd: `${namespace}:endpoints-session-end`,
    registrations: `${namespace}:registrations`,
    notices: (player: string) => `${namespace}:notices:${enc(player)}`,
    send: (key: string) => `${namespace}:send:${enc(key)}`,
    due: `${namespace}:sends:due`,
    changed: `${namespace}:sends:changed`,
    inFlight: (player: string) => `${namespace}:sends:in-flight:${enc(player)}`,
    history: (player: string) => `${namespace}:history:${enc(player)}`,
    historyAt: (player: string) => `${namespace}:history-at:${enc(player)}`,
    historyAll: `${namespace}:history-all`,
    commitMarker: `${namespace}:commit`,
  };

  /**
   * Runs one atomic step: watches `watched`, lets `plan` read and decide,
   * and queues its commands in one MULTI/EXEC. A plan without commands only
   * unwatches. A transaction that another writer aborted is planned again.
   *
   * `@devvit/redis` drops from the EXEC result every reply it cannot map,
   * which may include a protobuf zero (a ZREM or HSET that changed nothing),
   * and resolves an aborted transaction as an empty array. So each
   * transaction ends with a SET of the namespace's commit marker, whose `OK`
   * always maps: a committed EXEC answers at least that reply, and only an
   * empty, `null`, or all-nil result is an abort.
   */
  async function transact<Result>(
    watched: readonly string[],
    plan: () => Promise<Plan<Result>>,
  ): Promise<Result> {
    return transactPrepared(async () => ({ watched, plan }));
  }

  /**
   * As `transact`, with the watched keys chosen from a read before WATCH:
   * `prepare` reads what decides them, and a plan that finds that read
   * outdated once the keys are watched answers `retry`.
   */
  async function transactPrepared<Result>(
    prepare: () => Promise<{
      readonly watched: readonly string[];
      readonly plan: () => Promise<Plan<Result>>;
    }>,
  ): Promise<Result> {
    let lastWatched: readonly string[] = [];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await backoff(attempt);
      }
      const { watched, plan } = await prepare();
      lastWatched = watched;
      const transaction = await redis.watch(...watched);
      let multiStarted = false;
      try {
        const planned = await plan();
        if ('retry' in planned) {
          await transaction.unwatch();
          continue;
        }
        const { commands, result } = planned;
        if (commands.length === 0) {
          await transaction.unwatch();
          return result;
        }
        await transaction.multi();
        multiStarted = true;
        for (const command of commands) {
          await command(transaction);
        }
        await transaction.set(keys.commitMarker, commitMarkerValue);
        const results = await transaction.exec();
        if (results !== null && !Array.isArray(results)) {
          throw new Error('Devvit Redis transaction returned an unsupported response.');
        }
        // An aborted WATCH transaction (another writer changed a watched
        // key) answers no reply; one that answers only nil is read the same
        // way, since no command queued here replies nil when it commits.
        if (results === null || results.every((reply) => reply === null || reply === undefined)) {
          continue;
        }
        return result;
      } catch (error) {
        await bestEffortReset(transaction, multiStarted);
        throw error;
      }
    }
    throw new Error(
      `Devvit Redis notification store: contention exceeded ${String(attempts)} attempts on ${String(lastWatched.length)} watched key(s).`,
    );
  }

  /** The members of a sorted set in score order, read in pages, up to `limit`. */
  async function scoreRange(
    key: string,
    min: string,
    max: string,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<string[]> {
    const members: string[] = [];
    for (let offset = 0; members.length < limit; offset += pageSize) {
      const count = Math.min(pageSize, limit - members.length);
      const page = await redis.zRange(key, min, max, {
        by: 'score',
        limit: { offset, count },
      });
      for (const entry of page) {
        members.push(entry.member);
      }
      if (page.length < count) {
        break;
      }
    }
    return members;
  }

  const endpointMember = (provider: string, installationId: string): string =>
    JSON.stringify([provider, installationId]);

  async function readEndpoint(
    provider: string,
    installationId: string,
  ): Promise<NotificationStoredEndpoint | undefined> {
    const key = keys.endpoint(provider, installationId);
    const value = await redis.get(key);
    return isMissing(value) ? undefined : parse<NotificationStoredEndpoint>(value, key);
  }

  /**
   * The commands that move an endpoint from `before` to `after` (either may
   * be absent) with its address pointer and indexes. `ownsOldAddress` says
   * whether `before`'s address pointer still names this installation, so a
   * pointer another installation took is never deleted; `writeAddress`
   * false keeps the pointer as it is (an update that keeps the address).
   */
  function endpointCommands(
    before: NotificationStoredEndpoint | undefined,
    after: NotificationStoredEndpoint | undefined,
    ownsOldAddress: boolean,
    writeAddress = true,
  ): Command[] {
    const subject = after ?? before;
    if (subject === undefined) {
      return [];
    }
    const { provider, installationId } = subject;
    const member = endpointMember(provider, installationId);
    const commands: Command[] = [];
    const valueKey = keys.endpoint(provider, installationId);
    if (after === undefined) {
      commands.push((transaction) => transaction.del(valueKey));
    } else {
      const value = JSON.stringify(after);
      commands.push((transaction) => transaction.set(valueKey, value));
    }
    if (
      before !== undefined
      && ownsOldAddress
      && (after === undefined || before.address.value !== after.address.value)
    ) {
      const oldAddress = keys.endpointAddress(provider, before.address.value);
      commands.push((transaction) => transaction.del(oldAddress));
    }
    if (after !== undefined && writeAddress) {
      const address = keys.endpointAddress(provider, after.address.value);
      commands.push((transaction) => transaction.set(address, installationId));
    }
    const moved = (field: 'player' | 'sessionId', key: (value: string) => string): void => {
      if (before !== undefined && (after === undefined || before[field] !== after[field])) {
        const old = key(before[field]);
        commands.push((transaction) => transaction.zRem(old, [member]));
      }
      if (after !== undefined) {
        const next = key(after[field]);
        commands.push((transaction) => transaction.zAdd(next, { member, score: 0 }));
      }
    };
    moved('player', keys.endpointsByPlayer);
    moved('sessionId', keys.endpointsBySession);
    const byInstallation = keys.endpointsByInstallation(installationId);
    if (after === undefined) {
      commands.push((transaction) => transaction.zRem(byInstallation, [provider]));
    } else {
      commands.push((transaction) =>
        transaction.zAdd(byInstallation, { member: provider, score: 0 }),
      );
    }
    // The purge indexes, one per cutoff, scored by the time it compares.
    const timed = (key: string, at: string | undefined): void => {
      if (at === undefined) {
        commands.push((transaction) => transaction.zRem(key, [member]));
      } else {
        const score = Date.parse(at);
        commands.push((transaction) => transaction.zAdd(key, { member, score }));
      }
    };
    timed(keys.endpointsRegistered, after?.lastRegisteredAt);
    timed(keys.endpointsInvalidated, after?.status === 'invalid' ? after.invalidatedAt : undefined);
    timed(keys.endpointsSessionEnd, after?.sessionExpiresAt);
    return commands;
  }

  /**
   * Removes one endpoint, atomically, while `matches` holds for it; answers
   * whether it did. An index entry that names an endpoint whose value is
   * gone is dropped from `prune` (`[key, member]` pairs).
   */
  async function removeEndpointIf(
    provider: string,
    installationId: string,
    matches: (endpoint: NotificationStoredEndpoint) => boolean,
    prune: readonly (readonly [string, string])[] = [],
  ): Promise<boolean> {
    return transactPrepared(async () => {
      const seen = await readEndpoint(provider, installationId);
      const valueKey = keys.endpoint(provider, installationId);
      return {
        watched: seen === undefined
          ? [valueKey]
          : [valueKey, keys.endpointAddress(provider, seen.address.value)],
        plan: async (): Promise<Plan<boolean>> => {
          const endpoint = await readEndpoint(provider, installationId);
          if (JSON.stringify(endpoint) !== JSON.stringify(seen)) {
            return { retry: true };
          }
          if (endpoint === undefined) {
            return {
              commands: prune.map(
                ([key, member]) => (transaction: DevvitNotificationRedisTransaction) =>
                  transaction.zRem(key, [member]),
              ),
              result: false,
            };
          }
          if (!matches(endpoint)) {
            return { commands: [], result: false };
          }
          const owner = await redis.get(keys.endpointAddress(provider, endpoint.address.value));
          return {
            commands: endpointCommands(endpoint, undefined, owner === installationId),
            result: true,
          };
        },
      };
    });
  }

  /** Every endpoint an index names, as `[provider, installationId]`. */
  async function indexedEndpoints(key: string): Promise<[string, string][]> {
    const members = await redis.zRange(key, 0, -1, { by: 'rank' });
    return members.flatMap((entry) => {
      const named = tryParse<unknown>(entry.member);
      return Array.isArray(named) && typeof named[0] === 'string' && typeof named[1] === 'string'
        ? [[named[0], named[1]] as [string, string]]
        : [];
    });
  }

  /** The index commands that follow a send from `before` to `after` (either may be absent). */
  function sendIndexCommands(
    key: string,
    before: NotificationStoredSend | undefined,
    after: NotificationStoredSend | undefined,
  ): Command[] {
    const commands: Command[] = [];
    const due = after === undefined ? undefined : notificationSendDueAt(after);
    if (due === undefined) {
      if (before !== undefined) {
        commands.push((transaction) => transaction.zRem(keys.due, [key]));
      }
    } else {
      commands.push((transaction) =>
        transaction.zAdd(keys.due, { member: key, score: Date.parse(due) }),
      );
    }
    if (after === undefined) {
      commands.push((transaction) => transaction.zRem(keys.changed, [key]));
    } else {
      commands.push((transaction) =>
        transaction.zAdd(keys.changed, { member: key, score: Date.parse(after.changedAt) }),
      );
    }
    const flying = (send: NotificationStoredSend | undefined): boolean =>
      send !== undefined && send.rows.some((row) => row.state.status === 'in-flight');
    if (before !== undefined && flying(before) && !flying(after)) {
      commands.push((transaction) => transaction.zRem(keys.inFlight(before.request.player), [key]));
    }
    if (after !== undefined && flying(after)) {
      commands.push((transaction) =>
        transaction.zAdd(keys.inFlight(after.request.player), { member: key, score: 0 }),
      );
    }
    return commands;
  }

  /** A stored send value, or `'unreadable'` for one that is not a send. */
  function readSendValue(raw: string): StoredSendValue | 'unreadable' {
    const value = tryParse<{ readonly version?: unknown; readonly send?: Partial<NotificationStoredSend> } | null>(
      raw,
    );
    const send = typeof value === 'object' && value !== null ? value.send : undefined;
    return typeof value?.version === 'string'
      && typeof send === 'object' && send !== null
      && typeof send.key === 'string'
      && typeof send.changedAt === 'string'
      && typeof send.request?.player === 'string'
      && Array.isArray(send.rows)
      && send.rows.every((row: unknown) => {
        const candidate = row as { readonly key?: unknown; readonly provider?: unknown; readonly state?: { readonly status?: unknown } } | null;
        return typeof candidate === 'object' && candidate !== null
          && typeof candidate.key === 'string'
          && typeof candidate.provider === 'string'
          && typeof candidate.state?.status === 'string';
      })
      ? value as StoredSendValue
      : 'unreadable';
  }

  async function readSend(key: string): Promise<StoredSendValue | undefined> {
    const value = await redis.get(keys.send(key));
    if (isMissing(value)) {
      return undefined;
    }
    const stored = readSendValue(value);
    if (stored === 'unreadable') {
      throw new Error(
        `Devvit Redis notification store: ${keys.send(key)} holds a value that is not a send.`,
      );
    }
    return stored;
  }

  return {
    async appendConsent({ player, record, at }) {
      const key = keys.consent(player);
      return transact([key], async () => {
        const [latest] = await redis.zRange(key, -1, -1, { by: 'rank' });
        let millis = Date.parse(at);
        if (latest !== undefined) {
          millis = Math.max(millis, latest.score + 1);
        }
        const stored = { ...record, at: formatNotificationInstant(millis) } as NotificationConsentRecord;
        const member = JSON.stringify(stored);
        return {
          commands: [(transaction) => transaction.zAdd(key, { member, score: millis })],
          result: structuredClone(stored),
        };
      });
    },
    async listConsent(player) {
      const key = keys.consent(player);
      const members = await redis.zRange(key, 0, -1, { by: 'rank' });
      return members.map((entry) => parse<NotificationConsentRecord>(entry.member, key));
    },

    async putEndpoint(write) {
      const { provider, installationId } = write;
      const valueKey = keys.endpoint(provider, installationId);
      const addressKey = keys.endpointAddress(provider, write.address.value);
      return transactPrepared(async () => {
        // What decides the watched keys: this installation's endpoint, and
        // the installation the new address points to now.
        const seen = await readEndpoint(provider, installationId);
        const seenOwner = await redis.get(addressKey);
        const watched = [valueKey, addressKey];
        if (seen !== undefined && seen.address.value !== write.address.value) {
          watched.push(keys.endpointAddress(provider, seen.address.value));
        }
        if (!isMissing(seenOwner) && seenOwner !== installationId) {
          watched.push(keys.endpoint(provider, seenOwner));
        }
        return {
          watched,
          plan: async (): Promise<Plan<NotificationStoredEndpoint>> => {
            const existing = await readEndpoint(provider, installationId);
            const owner = await redis.get(addressKey);
            if (JSON.stringify(existing) !== JSON.stringify(seen) || owner !== seenOwner) {
              return { retry: true };
            }
            const commands: Command[] = [];
            if (!isMissing(owner) && owner !== installationId) {
              // An address is unique per provider: the other installation loses it.
              const other = await readEndpoint(provider, owner);
              if (other !== undefined) {
                commands.push(...endpointCommands(other, undefined, false));
              }
            }
            const dead = existing?.status === 'invalid' && existing.address.value === write.address.value;
            const stored: NotificationStoredEndpoint = {
              ...structuredClone(write),
              status: dead ? 'invalid' : 'valid',
              ...(dead && existing.invalidatedAt !== undefined ? { invalidatedAt: existing.invalidatedAt } : {}),
            };
            const ownsOldAddress = existing !== undefined
              && (await redis.get(keys.endpointAddress(provider, existing.address.value))) === installationId;
            commands.push(...endpointCommands(existing, stored, ownsOldAddress));
            return { commands, result: structuredClone(stored) };
          },
        };
      });
    },
    async listEndpoints({ player, provider }) {
      const named = (await indexedEndpoints(keys.endpointsByPlayer(player)))
        .filter(([indexed]) => indexed === provider);
      if (named.length === 0) {
        return [];
      }
      const values = await redis.mGet(named.map(([indexed, installation]) => keys.endpoint(indexed, installation)));
      return values
        .flatMap((value) => (isMissing(value) ? [] : [parse<NotificationStoredEndpoint>(value, keys.endpointsByPlayer(player))]))
        .filter((endpoint) => endpoint.player === player && endpoint.provider === provider)
        .sort((left, right) => compareText(left.installationId, right.installationId));
    },
    async getEndpoint({ provider, installationId }) {
      return readEndpoint(provider, installationId);
    },
    async invalidateEndpoint({ provider, installationId, value, at }) {
      await transact([keys.endpoint(provider, installationId)], async () => {
        const endpoint = await readEndpoint(provider, installationId);
        if (endpoint === undefined || endpoint.address.value !== value || endpoint.status !== 'valid') {
          return { commands: [], result: undefined };
        }
        const invalid: NotificationStoredEndpoint = { ...endpoint, status: 'invalid', invalidatedAt: at };
        return { commands: endpointCommands(endpoint, invalid, true, false), result: undefined };
      });
    },
    async removeEndpoints({ installationId, player, provider }) {
      const providers = provider === undefined
        ? (await redis.zRange(keys.endpointsByInstallation(installationId), 0, -1, { by: 'rank' }))
          .map((entry) => entry.member)
        : [provider];
      for (const named of providers) {
        await removeEndpointIf(named, installationId, (endpoint) => endpoint.player === player, [
          [keys.endpointsByInstallation(installationId), named],
        ]);
      }
    },
    async removeSessionEndpoints({ sessionId }) {
      let removed = 0;
      for (const [provider, installationId] of await indexedEndpoints(keys.endpointsBySession(sessionId))) {
        if (await removeEndpointIf(provider, installationId, (endpoint) => endpoint.sessionId === sessionId)) {
          removed += 1;
        }
      }
      return removed;
    },
    async extendSessionEndpoints({ sessionId, expiresAt }) {
      let changed = 0;
      for (const [provider, installationId] of await indexedEndpoints(keys.endpointsBySession(sessionId))) {
        const key = keys.endpoint(provider, installationId);
        const moved = await transact([key], async () => {
          const endpoint = await readEndpoint(provider, installationId);
          if (
            endpoint === undefined
            || endpoint.sessionId !== sessionId
            || endpoint.sessionExpiresAt === undefined
            || (expiresAt !== undefined && Date.parse(endpoint.sessionExpiresAt) >= Date.parse(expiresAt))
          ) {
            return { commands: [], result: false };
          }
          const { sessionExpiresAt: _earlier, ...kept } = endpoint;
          const moved: NotificationStoredEndpoint = expiresAt === undefined ? kept : { ...kept, sessionExpiresAt: expiresAt };
          return { commands: endpointCommands(endpoint, moved, true, false), result: true };
        });
        if (moved) {
          changed += 1;
        }
      }
      return changed;
    },

    async putPlatformRegistration(registration) {
      const field = JSON.stringify([registration.player, registration.provider]);
      const value = JSON.stringify(registration);
      // One write that reads nothing: no transaction, so registrations never contend.
      await redis.hSet(keys.registrations, { [field]: value });
    },
    async getPlatformRegistration({ player, provider }) {
      const value = await redis.hGet(keys.registrations, JSON.stringify([player, provider]));
      return isMissing(value)
        ? undefined
        : parse<NotificationPlatformRegistration>(value, keys.registrations);
    },

    async addNoticeGiven(notice) {
      const key = keys.notices(notice.player);
      // Named by the notice, its record's instant to the millisecond, and its date.
      const field = JSON.stringify([
        notice.kind,
        notice.record.kind,
        Date.parse(notice.record.at),
        notice.dueBy,
      ]);
      await transact([key], async () => {
        if (!isMissing(await redis.hGet(key, field))) {
          return { commands: [], result: undefined };
        }
        const value = JSON.stringify(notice);
        return {
          commands: [(transaction) => transaction.hSet(key, { [field]: value })],
          result: undefined,
        };
      });
    },
    async listNoticesGiven(player) {
      const key = keys.notices(player);
      return Object.values(await redis.hGetAll(key))
        .map((value) => parse<NotificationNoticeGiven>(value, key))
        .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    },

    async getSend(key): Promise<NotificationVersionedSend | undefined> {
      const stored = await readSend(key);
      return stored === undefined ? undefined : { send: stored.send, version: stored.version };
    },
    async createSend(send) {
      const valueKey = keys.send(send.key);
      return transact([valueKey], async () => {
        if (!isMissing(await redis.get(valueKey))) {
          return { commands: [], result: undefined };
        }
        const version = newVersion();
        const value = JSON.stringify({ send, version } satisfies StoredSendValue);
        return {
          commands: [
            (transaction) => transaction.set(valueKey, value),
            ...sendIndexCommands(send.key, undefined, send),
          ],
          result: version,
        };
      });
    },
    async updateSend({ key, version, send }) {
      const valueKey = keys.send(key);
      return transact([valueKey], async () => {
        const stored = await readSend(key);
        if (stored === undefined || stored.version !== version) {
          return { commands: [], result: false };
        }
        if (send === undefined) {
          return {
            commands: [
              (transaction) => transaction.del(valueKey),
              ...sendIndexCommands(key, stored.send, undefined),
            ],
            result: true,
          };
        }
        const value = JSON.stringify({ send, version: newVersion() } satisfies StoredSendValue);
        return {
          commands: [
            (transaction) => transaction.set(valueKey, value),
            ...sendIndexCommands(key, stored.send, send),
          ],
          result: true,
        };
      });
    },
    async listInFlightSends(player) {
      const index = await redis.zRange(keys.inFlight(player), 0, -1, { by: 'rank' });
      if (index.length === 0) {
        return [];
      }
      const values = await redis.mGet(index.map((entry) => keys.send(entry.member)));
      const sends: NotificationStoredSend[] = [];
      for (const value of values) {
        if (isMissing(value)) {
          continue;
        }
        const stored = readSendValue(value);
        if (stored === 'unreadable') {
          // An unreadable row is not this player's in-flight send; purge drops it.
          continue;
        }
        const { send } = stored;
        if (send.request.player === player && send.rows.some((row) => row.state.status === 'in-flight')) {
          sends.push(send);
        }
      }
      return sends;
    },
    async listDueSends({ at, limit }) {
      const count = Math.max(0, Math.floor(limit));
      if (count === 0) {
        return [];
      }
      const due: string[] = [];
      const seen = new Set<string>();
      let offset = 0;
      while (due.length < count) {
        const want = Math.min(pageSize, count - due.length);
        const page = await redis.zRange(keys.due, '-inf', String(Date.parse(at)), {
          by: 'score',
          limit: { offset, count: want },
        });
        for (const entry of page) {
          // Offsets move while other workers write the index: keep each key once.
          if (!seen.has(entry.member)) {
            seen.add(entry.member);
            due.push(entry.member);
          }
        }
        if (page.length < want) {
          break;
        }
        offset += page.length;
      }
      return due;
    },

    async addHistory(entry) {
      const key = keys.history(entry.player);
      const field = JSON.stringify([entry.sendKey, entry.provider]);
      await transact([key], async () => {
        if (!isMissing(await redis.hGet(key, field))) {
          return { commands: [], result: undefined };
        }
        const value = JSON.stringify(entry);
        const score = Date.parse(entry.at);
        const everywhere = JSON.stringify([entry.player, field]);
        return {
          commands: [
            (transaction) => transaction.hSet(key, { [field]: value }),
            (transaction) => transaction.zAdd(keys.historyAt(entry.player), { member: field, score }),
            (transaction) => transaction.zAdd(keys.historyAll, { member: everywhere, score }),
          ],
          result: undefined,
        };
      });
    },
    async listHistory({ player, since }) {
      const fields = await scoreRange(keys.historyAt(player), String(Date.parse(since)), '+inf');
      if (fields.length === 0) {
        return [];
      }
      const key = keys.history(player);
      const values = await redis.hMGet(key, fields);
      return values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => parse<NotificationHistoryEntry>(value, key))
        .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    },

    async purge(cutoffs) {
      // Oldest first; with `purgeLimit`, at most that many sends and history
      // rows per call, and the next scheduled purge continues.
      let sendCount = 0;
      const sendsBefore = Date.parse(cutoffs.sendsChangedBefore);
      for (const key of await scoreRange(keys.changed, '-inf', `(${String(sendsBefore)}`, purgeLimit)) {
        const valueKey = keys.send(key);
        const deleted = await transact([valueKey], async () => {
          // A Redis failure here fails the purge; only a value that does not
          // parse as a send is dropped, since nothing can use it.
          const raw = await redis.get(valueKey);
          const stored = isMissing(raw) ? undefined : readSendValue(raw);
          if (stored === 'unreadable') {
            // Its in-flight index entry, if any, names a player the value no
            // longer tells; listInFlightSends skips the missing value.
            return {
              commands: [
                (transaction) => transaction.del(valueKey),
                (transaction) => transaction.zRem(keys.changed, [key]),
                (transaction) => transaction.zRem(keys.due, [key]),
              ],
              result: true,
            };
          }
          if (stored === undefined) {
            // A stale index entry: drop it from the indexes that hold it by key.
            return {
              commands: [
                (transaction) => transaction.zRem(keys.changed, [key]),
                (transaction) => transaction.zRem(keys.due, [key]),
              ],
              result: false,
            };
          }
          if (!(Date.parse(stored.send.changedAt) < sendsBefore)) {
            return { commands: [], result: false };
          }
          return {
            commands: [
              (transaction) => transaction.del(valueKey),
              ...sendIndexCommands(key, stored.send, undefined),
            ],
            result: true,
          };
        });
        if (deleted) {
          sendCount += 1;
        }
      }

      let historyCount = 0;
      const historyBefore = Date.parse(cutoffs.historyBefore);
      for (const member of await scoreRange(keys.historyAll, '-inf', `(${String(historyBefore)}`, purgeLimit)) {
        const named = tryParse<unknown>(member);
        if (
          !Array.isArray(named)
          || named.length !== 2
          || typeof named[0] !== 'string'
          || typeof named[1] !== 'string'
        ) {
          await transact([keys.historyAll], async () => ({
            commands: [(transaction) => transaction.zRem(keys.historyAll, [member])],
            result: undefined,
          }));
          continue;
        }
        const [player, field] = named as [string, string];
        const key = keys.history(player);
        const removed = await transact([key], async () => {
          const value = await redis.hGet(key, field);
          const entry = isMissing(value) ? undefined : tryParse<Partial<NotificationHistoryEntry> | null>(value);
          const at = typeof entry?.at === 'string' ? Date.parse(entry.at) : Number.NaN;
          if (!isMissing(value) && Number.isFinite(at) && at >= historyBefore) {
            // Not old after all (never written so): keep the entry and its indexes.
            return { commands: [], result: false };
          }
          return {
            commands: [
              ...(isMissing(value)
                ? []
                : [(transaction: DevvitNotificationRedisTransaction) => transaction.hDel(key, [field])]),
              (transaction) => transaction.zRem(keys.historyAt(player), [field]),
              (transaction) => transaction.zRem(keys.historyAll, [member]),
            ],
            result: !isMissing(value),
          };
        });
        if (removed) {
          historyCount += 1;
        }
      }

      const before = (at: string | undefined, cutoff: string): boolean =>
        at !== undefined && Date.parse(at) < Date.parse(cutoff);
      // Each cutoff reads only the endpoints past it, from its time index.
      let endpointCount = 0;
      const pastCutoff = (endpoint: NotificationStoredEndpoint): boolean =>
        (endpoint.status === 'invalid' && before(endpoint.invalidatedAt, cutoffs.invalidEndpointsBefore))
        || before(endpoint.lastRegisteredAt, cutoffs.staleEndpointsBefore)
        || before(endpoint.sessionExpiresAt, cutoffs.sessionEndpointsBefore);
      for (const [index, cutoff] of [
        [keys.endpointsInvalidated, cutoffs.invalidEndpointsBefore],
        [keys.endpointsRegistered, cutoffs.staleEndpointsBefore],
        [keys.endpointsSessionEnd, cutoffs.sessionEndpointsBefore],
      ] as const) {
        const members = await scoreRange(index, '-inf', `(${String(Date.parse(cutoff))}`, purgeLimit);
        for (const member of members) {
          const named = tryParse<unknown>(member);
          if (!Array.isArray(named) || typeof named[0] !== 'string' || typeof named[1] !== 'string') {
            await transact([index], async () => ({
              commands: [(transaction) => transaction.zRem(index, [member])],
              result: undefined,
            }));
            continue;
          }
          if (await removeEndpointIf(named[0], named[1], pastCutoff, [[index, member]])) {
            endpointCount += 1;
          }
        }
      }

      return { sends: sendCount, history: historyCount, endpoints: endpointCount };
    },
  };
}

/** Up to about 2 ms per attempt, jittered: enough to break lockstep retries. */
function defaultBackoff(attempt: number): Promise<void> {
  const delayMs = Math.random() * 2 * Math.min(attempt, 8);
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/** A missing key, field, or member: `@devvit/redis` answers `undefined`, a classic client `null`. */
function isMissing(value: string | null | undefined): value is null | undefined {
  return value === undefined || value === null;
}

function tryParse<Value>(value: string): Value | undefined {
  try {
    return JSON.parse(value) as Value;
  } catch {
    return undefined;
  }
}

function parse<Value>(value: string, key: string): Value {
  try {
    return JSON.parse(value) as Value;
  } catch (error) {
    throw new Error(`Devvit Redis notification store: ${key} holds a value that is not JSON.`, {
      cause: error,
    });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function bestEffortReset(
  transaction: DevvitNotificationRedisTransaction,
  multiStarted: boolean,
): Promise<void> {
  try {
    if (multiStarted) {
      await transaction.discard();
    } else {
      await transaction.unwatch();
    }
  } catch {
    // Keep the original Redis failure; this cleanup is best-effort.
  }
}
