import {
  normalizeNotificationTimestamp,
  type NotificationConsentRecord,
  type NotificationDeferralReason,
  type NotificationDeliveryOutcome,
  type NotificationNoticeIdentity,
  type NotificationNoticeVariant,
  type NotificationPermissionState,
  type NotificationTemplateData,
} from '@mpgd/platform/notifications';

import type { NotificationDeviceAddress } from './delivery-provider.js';

/**
 * Persistence for the notifications service (notifications v2 RFC, "Server"):
 * consent records, the endpoint registry, platform-user registrations, the
 * notices given, the send ledger with its per-recipient rows, and the
 * delivery history the gate's limits count. The service owns every rule; a
 * store only keeps rows and answers the few atomic steps listed on each
 * method. `createInMemoryNotificationStore` is the reference implementation;
 * the game-services Worker ships a D1 one.
 */

/** Each member of a union without `key`. */
type OmitEach<Union, Key extends PropertyKey> = Union extends unknown ? Omit<Union, Key> : never;

/** A consent record before the backend dates it. */
export type NotificationConsentRecordInput = OmitEach<NotificationConsentRecord, 'at'>;

/** A device endpoint, keyed by provider and installation. */
export interface NotificationStoredEndpoint {
  readonly provider: string;
  /** The registering session's installation id, never a request field. */
  readonly installationId: string;
  readonly player: string;
  readonly address: NotificationDeviceAddress;
  /** The device permission the latest registration reported. */
  readonly permission: NotificationPermissionState;
  readonly status: 'valid' | 'invalid';
  readonly locale?: string;
  readonly timeZone?: string;
  /** The catalog target whose mapping applies to this device (`android`, `ios`). */
  readonly target?: string;
  /** The session that registered the endpoint; its end unbinds it. */
  readonly sessionId: string;
  /** When that session ends on its own; the endpoint counts as unbound from then. */
  readonly sessionExpiresAt?: string;
  readonly lastRegisteredAt: string;
  readonly invalidatedAt?: string;
}

/** What a registration writes; the store decides `status`. */
export type NotificationEndpointWrite = Omit<NotificationStoredEndpoint, 'status' | 'invalidatedAt'>;

/** A platform-user registration: only the locale and zone; the recipient comes from the identity. */
export interface NotificationPlatformRegistration {
  readonly player: string;
  readonly provider: string;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly registeredAt: string;
}

export type NotificationNoticeChannel = 'in-game' | 'push' | 'other';

/** A notice given to a player: which notice (its name), how, and when. */
export interface NotificationNoticeGiven extends NotificationNoticeIdentity {
  readonly player: string;
  readonly channel: NotificationNoticeChannel;
  readonly at: string;
}

/** One delivered send, which the gate's frequency caps and provider limits count. */
export interface NotificationHistoryEntry {
  readonly sendKey: string;
  readonly provider: string;
  readonly player: string;
  readonly topic: string;
  readonly at: string;
}

/** The request a send key is bound to (`notificationSendFingerprint`). */
export interface NotificationStoredSendRequest {
  readonly idempotencyKey: string;
  readonly player: string;
  readonly provider?: string;
  readonly topic: string;
  readonly templateData?: NotificationTemplateData;
  readonly data?: Readonly<Record<string, string>>;
  readonly locale?: string;
  readonly link?: string;
}

/** Why the send exists: a direct send, or a scheduler item (S2 writes these). */
export type NotificationSendOrigin =
  | { readonly kind: 'send' }
  | { readonly kind: 'reminder'; readonly key: string }
  | {
      readonly kind: 'notice';
      readonly notice: NotificationNoticeIdentity;
      readonly variant: NotificationNoticeVariant;
    };

/** Rate-limit backoff of one recipient, from its first `rate-limited` answer. */
export interface NotificationRateLimitState {
  readonly since: string;
  readonly delaySeconds: number;
  readonly attempts: number;
}

export type NotificationSendRowState =
  | { readonly status: 'delivered' }
  | {
      readonly status: 'deferred';
      readonly reason: NotificationDeferralReason;
      readonly until: string;
    }
  | {
      /**
       * Claimed or waiting to be claimed. `claim` names the holder; a row
       * without one is queued and was never sent. `attempted` turns true when
       * a holder claimed it to call the provider, so an expired lease means
       * the provider may have sent it.
       */
      readonly status: 'in-flight';
      readonly leaseUntil: string;
      readonly claim?: string;
      readonly attempted: boolean;
      /** When the latest holder claimed it to call the provider. */
      readonly attemptedAt?: string;
    };

/** One recipient's ledger delivery of a send. */
export interface NotificationSendRow {
  /** The ledger key: the send key, or `<send key>:<encodeURIComponent(installationId)>`. */
  readonly key: string;
  readonly provider: string;
  /** The endpoint's installation, for device addressing. */
  readonly installationId?: string;
  readonly state: NotificationSendRowState;
  readonly rateLimit?: NotificationRateLimitState;
  /**
   * When a claim that may have reached the provider first took the row. A
   * deferral or a rate-limit answer, which prove nothing was sent, keep the
   * earlier value, so ambiguous replays stop 24 hours after a real attempt.
   */
  readonly firstAttemptedAt?: string;
  /** Ambiguous answers so far; each doubles the lease before the next replay. */
  readonly ambiguousAttempts?: number;
}

/** A send key's stored state. */
export interface NotificationStoredSend {
  readonly key: string;
  readonly fingerprint: string;
  readonly request: NotificationStoredSendRequest;
  readonly origin: NotificationSendOrigin;
  /**
   * Whether a scheduler item (a reminder or a notice) or a due replay owns
   * the send. Every in-flight row whose lease ended is due either way; S2's
   * scheduler reads the flag for its own items.
   */
  readonly scheduled: boolean;
  readonly rows: readonly NotificationSendRow[];
  /** Held while the first evaluation runs, before any row exists. */
  readonly claim?: { readonly token: string; readonly leaseUntil: string };
  readonly changedAt: string;
}

/** A stored send with the version a conditional write must name. */
export interface NotificationVersionedSend {
  readonly send: NotificationStoredSend;
  readonly version: string;
}

export interface NotificationPurgeCutoffs {
  /** Sends whose last change is older than this are forgotten (key retention). */
  readonly sendsChangedBefore: string;
  readonly historyBefore: string;
  /** Endpoints invalidated before this are deleted. */
  readonly invalidEndpointsBefore: string;
  /** Endpoints last registered before this are deleted. */
  readonly staleEndpointsBefore: string;
  /** Endpoints whose session ended before this are deleted. */
  readonly sessionEndpointsBefore: string;
}

export interface NotificationPurgeCounts {
  readonly sends: number;
  readonly history: number;
  readonly endpoints: number;
}

export interface NotificationStore {
  /**
   * Appends a consent record for `player`, dated `at` or, when the player's
   * latest record is not earlier, 1 ms after it, so a record's kind and time
   * name it. Answers the stored record. Must be atomic per player.
   */
  appendConsent(input: {
    readonly player: string;
    readonly record: NotificationConsentRecordInput;
    readonly at: string;
  }): Promise<NotificationConsentRecord>;
  /** The player's consent records, oldest first. */
  listConsent(player: string): Promise<readonly NotificationConsentRecord[]>;

  /**
   * Binds a device endpoint, atomically: another installation's endpoint
   * with the same provider and address value is removed (an address is
   * unique per provider), and the endpoint stays `invalid` when its
   * installation re-registers the same dead address; any other write is
   * `valid`.
   */
  putEndpoint(endpoint: NotificationEndpointWrite): Promise<NotificationStoredEndpoint>;
  listEndpoints(input: {
    readonly player: string;
    readonly provider: string;
  }): Promise<readonly NotificationStoredEndpoint[]>;
  getEndpoint(input: {
    readonly provider: string;
    readonly installationId: string;
  }): Promise<NotificationStoredEndpoint | undefined>;
  /** Marks the endpoint invalid while it still holds `value`. */
  invalidateEndpoint(input: {
    readonly provider: string;
    readonly installationId: string;
    readonly value: string;
    readonly at: string;
  }): Promise<void>;
  /** Removes the installation's endpoints (of one provider, or all) that `player` holds. */
  removeEndpoints(input: {
    readonly installationId: string;
    readonly player: string;
    readonly provider?: string;
  }): Promise<void>;
  /** Removes every endpoint `sessionId` registered; answers how many. */
  removeSessionEndpoints(input: { readonly sessionId: string }): Promise<number>;
  /**
   * Moves the end of every endpoint `sessionId` registered to `expiresAt`
   * where the stored end is earlier, or clears it when the session no longer
   * ends on its own (`expiresAt` absent). An endpoint without an end keeps
   * none, and no end moves earlier. Answers how many changed.
   */
  extendSessionEndpoints(input: { readonly sessionId: string; readonly expiresAt?: string }): Promise<number>;

  putPlatformRegistration(registration: NotificationPlatformRegistration): Promise<void>;
  getPlatformRegistration(input: {
    readonly player: string;
    readonly provider: string;
  }): Promise<NotificationPlatformRegistration | undefined>;

  /** Records a notice given; a notice already recorded for the player stays as it was. */
  addNoticeGiven(notice: NotificationNoticeGiven): Promise<void>;
  listNoticesGiven(player: string): Promise<readonly NotificationNoticeGiven[]>;

  getSend(key: string): Promise<NotificationVersionedSend | undefined>;
  /** Stores a new send; answers its version, or `undefined` when the key exists. */
  createSend(send: NotificationStoredSend): Promise<string | undefined>;
  /**
   * Replaces (or, with `send: undefined`, deletes) the send while it still
   * has `version`; answers whether it did. Every write gets a new version.
   */
  updateSend(input: {
    readonly key: string;
    readonly version: string;
    readonly send: NotificationStoredSend | undefined;
  }): Promise<boolean>;
  /** The player's sends with at least one `in-flight` row. */
  listInFlightSends(player: string): Promise<readonly NotificationStoredSend[]>;
  /** Up to `limit` send keys with a row due at `at` (`notificationSendDueAt`), earliest first. */
  listDueSends(input: { readonly at: string; readonly limit: number }): Promise<readonly string[]>;

  /** Records a delivered send for one provider; a second record of the same pair is ignored. */
  addHistory(entry: NotificationHistoryEntry): Promise<void>;
  /** The player's deliveries at or after `since`, oldest first. */
  listHistory(input: {
    readonly player: string;
    readonly since: string;
  }): Promise<readonly NotificationHistoryEntry[]>;

  purge(cutoffs: NotificationPurgeCutoffs): Promise<NotificationPurgeCounts>;
}

// Shared derivations, used by the service and by every store's indexes.

type StoredOutcome = Extract<
  NotificationDeliveryOutcome,
  { readonly status: 'delivered' | 'deferred' | 'in-flight' }
>;

export function notificationRowOutcome(row: NotificationSendRow): StoredOutcome {
  switch (row.state.status) {
    case 'delivered':
      return { status: 'delivered', alreadyProcessed: false };
    case 'in-flight':
      return { status: 'in-flight' };
    case 'deferred':
      return { status: 'deferred', reason: row.state.reason, until: row.state.until };
  }
}

/**
 * How far a recipient's answer got, for a send's result across recipients:
 * delivered, in flight, waiting, a provider's refusal, a policy refusal, and
 * last a recipient that did not resolve.
 */
function outcomeRank(outcome: NotificationDeliveryOutcome): number {
  switch (outcome.status) {
    case 'delivered':
      return 5;
    case 'in-flight':
      return 4;
    case 'deferred':
      return 3;
    case 'unavailable':
      return outcome.reason === 'no-endpoint' || outcome.reason === 'link-missing' ? 0 : 2;
    case 'suppressed':
      return 1;
  }
}

/** The highest-ranked outcome, the earliest among deferred ones, the first among equals. */
export function bestNotificationOutcome<Outcome extends NotificationDeliveryOutcome>(
  outcomes: readonly Outcome[],
): Outcome | undefined {
  let best: Outcome | undefined;
  for (const outcome of outcomes) {
    if (
      best === undefined
      || outcomeRank(outcome) > outcomeRank(best)
      || (outcome.status === 'deferred'
        && best.status === 'deferred'
        && Date.parse(outcome.until) < Date.parse(best.until))
    ) {
      best = outcome;
    }
  }
  return best;
}

/** A send's stored outcome: its best row, or `in-flight` while its first evaluation holds the claim. */
export function notificationSendOutcome(send: NotificationStoredSend): StoredOutcome | undefined {
  const stored = bestNotificationOutcome(send.rows.map(notificationRowOutcome));
  return stored ?? (send.claim === undefined ? undefined : { status: 'in-flight' });
}

/** How long an ambiguous delivery is replayed before it is left in flight. */
export const notificationAmbiguousReplayHours = 24;
const ambiguousReplayMs = notificationAmbiguousReplayHours * 3_600_000;

/** When the scheduler may first take the row, or `undefined` when it never will. */
function rowDueAt(row: NotificationSendRow): number | undefined {
  if (row.state.status === 'deferred') {
    return Date.parse(row.state.until);
  }
  if (row.state.status !== 'in-flight') {
    return undefined;
  }
  const lease = Date.parse(row.state.leaseUntil);
  if (!row.state.attempted || row.firstAttemptedAt === undefined) {
    return lease;
  }
  // The provider may have sent it every time: replays stop after a day, and
  // the row stays in flight until its key's retention ends.
  return isNotificationRowAbandoned(row, lease) ? undefined : lease;
}

/**
 * Whether an attempted row is past its replays: its lease would end a day
 * or more after its first attempt.
 */
export function isNotificationRowAbandoned(row: NotificationSendRow, leaseUntil: number): boolean {
  return row.firstAttemptedAt !== undefined
    && leaseUntil - Date.parse(row.firstAttemptedAt) >= ambiguousReplayMs;
}

/**
 * Whether the scheduler may take a row at `at`: a deferred row once `until`
 * passed, and an in-flight row once its lease expired. That covers a queued
 * delivery whose message was lost, a claim whose holder failed before the
 * provider call, and an ambiguous answer, for a device endpoint, a scheduled
 * send, or a direct platform send whose caller never retries. Ambiguous
 * replays stop 24 hours after the first attempt.
 */
export function isNotificationRowDue(row: NotificationSendRow, at: number): boolean {
  const due = rowDueAt(row);
  return due !== undefined && due <= at;
}

/** When the scheduler may first take one of the send's rows, or `undefined` when none waits for it. */
export function notificationSendDueAt(send: NotificationStoredSend): string | undefined {
  let due: number | undefined;
  for (const row of send.rows) {
    const at = rowDueAt(row);
    if (at !== undefined && (due === undefined || at < due)) {
      due = at;
    }
  }
  return due === undefined ? undefined : formatNotificationInstant(due);
}

export function formatNotificationInstant(millis: number): string {
  return normalizeNotificationTimestamp(new Date(millis).toISOString());
}

// In-memory store.

/** The in-memory store's rows, for tests and conformance adapters. */
export interface InMemoryNotificationStoreState {
  readonly consent: readonly (NotificationConsentRecord & { readonly player: string })[];
  readonly endpoints: readonly NotificationStoredEndpoint[];
  readonly platformRegistrations: readonly NotificationPlatformRegistration[];
  readonly noticesGiven: readonly NotificationNoticeGiven[];
  readonly sends: readonly NotificationStoredSend[];
  readonly history: readonly NotificationHistoryEntry[];
}

export interface InMemoryNotificationStore extends NotificationStore {
  /** A deep copy of every row, read synchronously. */
  inspect(): InMemoryNotificationStoreState;
}

/**
 * A process-local store for tests, conformance runs, and local development.
 * Every method finishes its change before its first await, so concurrent
 * callers see each change whole. Production deployments use a durable store.
 */
export function createInMemoryNotificationStore(): InMemoryNotificationStore {
  const consent: { readonly player: string; readonly record: NotificationConsentRecord }[] = [];
  const endpoints: NotificationStoredEndpoint[] = [];
  const platformRegistrations = new Map<string, NotificationPlatformRegistration>();
  const noticesGiven: NotificationNoticeGiven[] = [];
  const sends = new Map<string, NotificationVersionedSend>();
  const history: NotificationHistoryEntry[] = [];
  let versions = 0;
  const nextVersion = (): string => {
    versions += 1;
    return `v${versions}`;
  };
  const copy = <Value>(value: Value): Value => structuredClone(value);
  const noticeName = (notice: NotificationNoticeIdentity & { readonly player: string }): string =>
    JSON.stringify([
      notice.player,
      notice.kind,
      notice.record.kind,
      Date.parse(notice.record.at),
      notice.dueBy,
    ]);

  return {
    inspect() {
      return copy({
        consent: consent.map((row) => ({ ...row.record, player: row.player })),
        endpoints,
        platformRegistrations: [...platformRegistrations.values()],
        noticesGiven,
        sends: [...sends.values()].map((entry) => entry.send),
        history,
      });
    },
    async appendConsent({ player, record, at }) {
      let millis = Date.parse(at);
      for (let index = consent.length - 1; index >= 0; index -= 1) {
        const row = consent[index];
        if (row !== undefined && row.player === player) {
          millis = Math.max(millis, Date.parse(row.record.at) + 1);
          break;
        }
      }
      const stored = { ...copy(record), at: formatNotificationInstant(millis) } as NotificationConsentRecord;
      consent.push({ player, record: stored });
      return copy(stored);
    },
    async listConsent(player) {
      return copy(consent.filter((row) => row.player === player).map((row) => row.record));
    },
    async putEndpoint(write) {
      for (let index = endpoints.length - 1; index >= 0; index -= 1) {
        const other = endpoints[index];
        if (
          other !== undefined
          && other.provider === write.provider
          && other.address.value === write.address.value
          && other.installationId !== write.installationId
        ) {
          endpoints.splice(index, 1);
        }
      }
      const index = endpoints.findIndex((endpoint) =>
        endpoint.provider === write.provider && endpoint.installationId === write.installationId);
      const existing = index === -1 ? undefined : endpoints[index];
      const dead = existing?.status === 'invalid' && existing.address.value === write.address.value;
      const stored: NotificationStoredEndpoint = {
        ...copy(write),
        status: dead ? 'invalid' : 'valid',
        ...(dead && existing.invalidatedAt !== undefined ? { invalidatedAt: existing.invalidatedAt } : {}),
      };
      if (index === -1) {
        endpoints.push(stored);
      } else {
        endpoints[index] = stored;
      }
      return copy(stored);
    },
    async listEndpoints({ player, provider }) {
      return copy(endpoints.filter((endpoint) =>
        endpoint.player === player && endpoint.provider === provider));
    },
    async getEndpoint({ provider, installationId }) {
      const endpoint = endpoints.find((candidate) =>
        candidate.provider === provider && candidate.installationId === installationId);
      return endpoint === undefined ? undefined : copy(endpoint);
    },
    async invalidateEndpoint({ provider, installationId, value, at }) {
      const index = endpoints.findIndex((endpoint) =>
        endpoint.provider === provider
        && endpoint.installationId === installationId
        && endpoint.address.value === value);
      const endpoint = endpoints[index];
      if (endpoint !== undefined && endpoint.status === 'valid') {
        endpoints[index] = { ...endpoint, status: 'invalid', invalidatedAt: at };
      }
    },
    async removeEndpoints({ installationId, player, provider }) {
      for (let index = endpoints.length - 1; index >= 0; index -= 1) {
        const endpoint = endpoints[index];
        if (
          endpoint !== undefined
          && endpoint.installationId === installationId
          && endpoint.player === player
          && (provider === undefined || endpoint.provider === provider)
        ) {
          endpoints.splice(index, 1);
        }
      }
    },
    async removeSessionEndpoints({ sessionId }) {
      let removed = 0;
      for (let index = endpoints.length - 1; index >= 0; index -= 1) {
        if (endpoints[index]?.sessionId === sessionId) {
          endpoints.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    async extendSessionEndpoints({ sessionId, expiresAt }) {
      let changed = 0;
      for (let index = 0; index < endpoints.length; index += 1) {
        const endpoint = endpoints[index];
        if (
          endpoint === undefined
          || endpoint.sessionId !== sessionId
          || endpoint.sessionExpiresAt === undefined
          || (expiresAt !== undefined && Date.parse(endpoint.sessionExpiresAt) >= Date.parse(expiresAt))
        ) {
          continue;
        }
        const { sessionExpiresAt: _earlier, ...kept } = endpoint;
        endpoints[index] = expiresAt === undefined ? kept : { ...kept, sessionExpiresAt: expiresAt };
        changed += 1;
      }
      return changed;
    },
    async putPlatformRegistration(registration) {
      platformRegistrations.set(
        JSON.stringify([registration.player, registration.provider]),
        copy(registration),
      );
    },
    async getPlatformRegistration({ player, provider }) {
      const registration = platformRegistrations.get(JSON.stringify([player, provider]));
      return registration === undefined ? undefined : copy(registration);
    },
    async addNoticeGiven(notice) {
      const name = noticeName(notice);
      if (!noticesGiven.some((given) => noticeName(given) === name)) {
        noticesGiven.push(copy(notice));
      }
    },
    async listNoticesGiven(player) {
      return copy(noticesGiven.filter((given) => given.player === player));
    },
    async getSend(key) {
      const entry = sends.get(key);
      return entry === undefined ? undefined : copy(entry);
    },
    async createSend(send) {
      if (sends.has(send.key)) {
        return undefined;
      }
      const version = nextVersion();
      sends.set(send.key, { send: copy(send), version });
      return version;
    },
    async updateSend({ key, version, send }) {
      const entry = sends.get(key);
      if (entry === undefined || entry.version !== version) {
        return false;
      }
      if (send === undefined) {
        sends.delete(key);
      } else {
        sends.set(key, { send: copy(send), version: nextVersion() });
      }
      return true;
    },
    async listInFlightSends(player) {
      return copy([...sends.values()]
        .map((entry) => entry.send)
        .filter((send) =>
          send.request.player === player && send.rows.some((row) => row.state.status === 'in-flight')));
    },
    async listDueSends({ at, limit }) {
      const now = Date.parse(at);
      return [...sends.values()]
        .flatMap(({ send }) => {
          const due = notificationSendDueAt(send);
          return due !== undefined && Date.parse(due) <= now ? [{ key: send.key, due: Date.parse(due) }] : [];
        })
        .sort((left, right) => left.due - right.due)
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.key);
    },
    async addHistory(entry) {
      if (!history.some((sent) => sent.sendKey === entry.sendKey && sent.provider === entry.provider)) {
        history.push(copy(entry));
        history.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      }
    },
    async listHistory({ player, since }) {
      const from = Date.parse(since);
      return copy(history.filter((sent) => sent.player === player && Date.parse(sent.at) >= from));
    },
    async purge(cutoffs) {
      const before = (at: string | undefined, cutoff: string): boolean =>
        at !== undefined && Date.parse(at) < Date.parse(cutoff);
      let sendCount = 0;
      for (const [key, entry] of [...sends]) {
        if (before(entry.send.changedAt, cutoffs.sendsChangedBefore)) {
          sends.delete(key);
          sendCount += 1;
        }
      }
      const historyBefore = history.length;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (before(history[index]?.at, cutoffs.historyBefore)) {
          history.splice(index, 1);
        }
      }
      let endpointCount = 0;
      for (let index = endpoints.length - 1; index >= 0; index -= 1) {
        const endpoint = endpoints[index];
        if (
          endpoint !== undefined
          && (
            (endpoint.status === 'invalid' && before(endpoint.invalidatedAt, cutoffs.invalidEndpointsBefore))
            || before(endpoint.lastRegisteredAt, cutoffs.staleEndpointsBefore)
            || before(endpoint.sessionExpiresAt, cutoffs.sessionEndpointsBefore)
          )
        ) {
          endpoints.splice(index, 1);
          endpointCount += 1;
        }
      }
      return { sends: sendCount, history: historyBefore - history.length, endpoints: endpointCount };
    },
  };
}
