import {
  assertPlayerDataErasureInput,
  type PlayerDataErasureInput,
  type PlayerDataErasureResult,
} from '../account-deletion.js';
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
 * notices given, the send ledger with its per-recipient rows, the delivery
 * history the gate's limits count, and the scheduler's entries (server
 * reminders and each player's notice check). The service owns every rule; a
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

/** Why the send exists: a direct send, or a scheduler item (a server reminder or a consent notice). */
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
   * the send. Every in-flight row whose lease ended is due either way, so no
   * rule reads it; it tells an operator who made the send.
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

/**
 * A server reminder a player set (RFC "Reminders"): one per player and key.
 * Once the scheduler turned it into its `reminder:` send it is `firedAt`,
 * no longer pending, and kept only so a later set or cancel can stop that
 * send while it still waits.
 */
export interface NotificationStoredReminder {
  readonly kind: 'reminder';
  readonly key: string;
  readonly topic: string;
  /** Canonical RFC 3339. */
  readonly fireAt: string;
  readonly templateData?: NotificationTemplateData;
  readonly link?: string;
  readonly firedAt?: string;
  /** A fired reminder's send fingerprint (its content), which names the send it made. */
  readonly fingerprint?: string;
}

/** When the scheduler next looks at a player's consent notices, with the backoff of refused pushes. */
export interface NotificationNoticeCheck {
  readonly kind: 'notices';
  /** Notice pushes refused in a row; each refusal doubles the wait before the next try. */
  readonly attempts: number;
  /** Notice send keys whose push could not render; each fails once and is not tried again. */
  readonly failed?: readonly string[];
  /**
   * Notice send keys the last check pushed: one that is gone at the next
   * check while its notice is still owed was refused when it was sent.
   */
  readonly pushed?: readonly string[];
}

export type NotificationScheduleItem = NotificationStoredReminder | NotificationNoticeCheck;

/**
 * One scheduler item of a player, named by `id` (`reminder:<key>` for a
 * reminder, `notices` for the notice check). The store keeps the item as
 * given and indexes `dueAt`; the service decides what it means.
 */
export interface NotificationScheduleEntry {
  readonly player: string;
  readonly id: string;
  /** When the scheduler takes the entry next; an entry without one is never listed as due. */
  readonly dueAt?: string;
  readonly item: NotificationScheduleItem;
}

/** A schedule entry with the version a conditional write must name. */
export interface NotificationVersionedScheduleEntry {
  readonly entry: NotificationScheduleEntry;
  readonly version: string;
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
   * Deletes the player's consent records dated at these instants (each of a
   * player's records has its own millisecond, so the instant names it), and
   * the notices given that report on them, in one atomic step. Answers how
   * many records it deleted. Callers never prune a player's latest record:
   * `appendConsent` dates a new record after the latest one that is left, so
   * an instant names one record for good only while the latest one stays.
   */
  pruneConsent(input: { readonly player: string; readonly at: readonly string[] }): Promise<number>;

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
  /**
   * Up to `limit` send keys with a row due at `at` (`notificationSendDueAt`),
   * earliest first, then by key. Equal due times use the same order as the
   * D1 store (`due_at_ms, send_key`) and a Redis sorted set's score ties.
   */
  listDueSends(input: { readonly at: string; readonly limit: number }): Promise<readonly string[]>;

  /** Records a delivered send for one provider; a second record of the same pair is ignored. */
  addHistory(entry: NotificationHistoryEntry): Promise<void>;
  /** The player's deliveries at or after `since`, oldest first. */
  listHistory(input: {
    readonly player: string;
    readonly since: string;
  }): Promise<readonly NotificationHistoryEntry[]>;
  /**
   * How many deliveries every player received through `provider` at or
   * after `since` and at or before `until`, for the scheduler's pacing. The
   * upper bound leaves out deliveries dated after the run's time (the clock
   * went back). It counts delivered sends only, so pacing is approximate
   * while other sends are in flight.
   */
  countHistory(input: {
    readonly provider: string;
    readonly since: string;
    readonly until: string;
  }): Promise<number>;

  getScheduleEntry(input: {
    readonly player: string;
    readonly id: string;
  }): Promise<NotificationVersionedScheduleEntry | undefined>;
  /**
   * Stores a new entry; answers its version, or `undefined` when the player
   * already has one with its id. A version is never reused, also after the
   * entry is deleted and created again. The store deletes no entry on its
   * own: the service removes a reminder or a notice check it is done with.
   */
  createScheduleEntry(entry: NotificationScheduleEntry): Promise<string | undefined>;
  /**
   * Replaces (or, with `entry: undefined`, deletes) the entry while it still
   * has `version`; answers whether it did. Every write gets a new version.
   * The entry is stored under `player` and `id`, whatever it names.
   */
  updateScheduleEntry(input: {
    readonly player: string;
    readonly id: string;
    readonly version: string;
    readonly entry: NotificationScheduleEntry | undefined;
  }): Promise<boolean>;
  /**
   * How many of the player's entries are pending server reminders: an id
   * that starts with `reminder:` and an item of kind `reminder` without
   * `firedAt`. The service caps a player's pending reminders with it.
   */
  countPendingReminders(player: string): Promise<number>;
  /**
   * Up to `limit` entries whose `dueAt` is at or before `at`: earliest
   * first, then by player and id.
   */
  listDueScheduleEntries(input: {
    readonly at: string;
    readonly limit: number;
  }): Promise<readonly { readonly player: string; readonly id: string }[]>;

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

/** Epoch milliseconds of a stored time; one that does not parse is a caller error, as in the D1 store. */
function instantOf(at: string): number {
  const millis = Date.parse(at);
  if (!Number.isFinite(millis)) {
    throw new TypeError(`Not a timestamp: ${JSON.stringify(at)}`);
  }
  return millis;
}

function dueOf(entry: NotificationScheduleEntry): number | undefined {
  return entry.dueAt === undefined ? undefined : instantOf(entry.dueAt);
}

/** The entry as a JSON store keeps it: under its key's player and id, without an undefined `dueAt`. */
function storedEntry(entry: NotificationScheduleEntry, player: string, id: string): NotificationScheduleEntry {
  const { dueAt, ...rest } = structuredClone(entry);
  return { ...rest, player, id, ...(dueAt === undefined ? {} : { dueAt }) };
}

/** Refuses an entry whose `dueAt` does not parse before anything is written. */
function assertDue(entry: NotificationScheduleEntry): void {
  dueOf(entry);
}

/** Code-point order, which is UTF-8 byte order: the order of SQLite's BINARY collation. */
function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
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
  readonly schedule: readonly NotificationScheduleEntry[];
}

export interface InMemoryNotificationStore extends NotificationStore {
  /** A deep copy of every row, read synchronously. */
  inspect(): InMemoryNotificationStoreState;
  /**
   * Account deletion (a `PlayerDataEraser`): removes every row of the player
   * (consent records, endpoints, platform registrations, notices given,
   * sends, delivery history, and schedule entries). Nothing is kept: no
   * notification data is under a legal retention period. The Worker's D1
   * deployment erases these tables in its own batch.
   */
  erasePlayerData(input: PlayerDataErasureInput): Promise<PlayerDataErasureResult>;
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
  const schedule = new Map<string, NotificationVersionedScheduleEntry>();
  const scheduleKey = (player: string, id: string): string => JSON.stringify([player, id]);
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
    async erasePlayerData(input) {
      const player = assertPlayerDataErasureInput(input).playerId;
      let removed = 0;
      const keep = <Row>(rows: Row[], belongs: (row: Row) => boolean): void => {
        let kept = 0;
        for (const row of rows) {
          if (belongs(row)) {
            removed += 1;
          } else {
            rows[kept] = row;
            kept += 1;
          }
        }
        rows.length = kept;
      };
      keep(consent, (row) => row.player === player);
      keep(endpoints, (endpoint) => endpoint.player === player);
      keep(noticesGiven, (notice) => notice.player === player);
      keep(history, (entry) => entry.player === player);
      for (const [key, registration] of [...platformRegistrations]) {
        if (registration.player === player) {
          platformRegistrations.delete(key);
          removed += 1;
        }
      }
      for (const [key, held] of [...sends]) {
        if (held.send.request.player === player) {
          sends.delete(key);
          removed += 1;
        }
      }
      for (const [key, held] of [...schedule]) {
        if (held.entry.player === player) {
          schedule.delete(key);
          removed += 1;
        }
      }
      return { deleted: removed, retained: 0 };
    },
    inspect() {
      return copy({
        consent: consent.map((row) => ({ ...row.record, player: row.player })),
        endpoints,
        platformRegistrations: [...platformRegistrations.values()],
        noticesGiven,
        sends: [...sends.values()].map((entry) => entry.send),
        history,
        schedule: [...schedule.values()].map((held) => held.entry),
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
    async pruneConsent({ player, at }) {
      const instants = new Set(at.map(instantOf));
      let removed = 0;
      for (let index = consent.length - 1; index >= 0; index -= 1) {
        const row = consent[index];
        if (row !== undefined && row.player === player && instants.has(Date.parse(row.record.at))) {
          consent.splice(index, 1);
          removed += 1;
        }
      }
      for (let index = noticesGiven.length - 1; index >= 0; index -= 1) {
        const given = noticesGiven[index];
        if (given !== undefined && given.player === player && instants.has(Date.parse(given.record.at))) {
          noticesGiven.splice(index, 1);
        }
      }
      return removed;
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
      const now = instantOf(at);
      return [...sends.values()]
        .flatMap(({ send }) => {
          const due = notificationSendDueAt(send);
          return due !== undefined && Date.parse(due) <= now ? [{ key: send.key, due: Date.parse(due) }] : [];
        })
        .sort((left, right) => left.due - right.due || compareCodePoints(left.key, right.key))
        .slice(0, Math.max(0, limit))
        .map((entry) => entry.key);
    },
    async addHistory(entry) {
      instantOf(entry.at);
      if (!history.some((sent) => sent.sendKey === entry.sendKey && sent.provider === entry.provider)) {
        history.push(copy(entry));
        history.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      }
    },
    async listHistory({ player, since }) {
      const from = instantOf(since);
      return copy(history.filter((sent) => sent.player === player && Date.parse(sent.at) >= from));
    },
    async countHistory({ provider, since, until }) {
      const from = instantOf(since);
      const to = instantOf(until);
      return history.filter((sent) =>
        sent.provider === provider && Date.parse(sent.at) >= from && Date.parse(sent.at) <= to).length;
    },
    async getScheduleEntry({ player, id }) {
      const held = schedule.get(scheduleKey(player, id));
      return held === undefined ? undefined : copy(held);
    },
    async createScheduleEntry(entry) {
      assertDue(entry);
      const key = scheduleKey(entry.player, entry.id);
      if (schedule.has(key)) {
        return undefined;
      }
      const version = nextVersion();
      schedule.set(key, { entry: storedEntry(entry, entry.player, entry.id), version });
      return version;
    },
    async updateScheduleEntry({ player, id, version, entry }) {
      if (entry !== undefined) {
        assertDue(entry);
      }
      const key = scheduleKey(player, id);
      const held = schedule.get(key);
      if (held === undefined || held.version !== version) {
        return false;
      }
      if (entry === undefined) {
        schedule.delete(key);
      } else {
        schedule.set(key, { entry: storedEntry(entry, player, id), version: nextVersion() });
      }
      return true;
    },
    async countPendingReminders(player) {
      return [...schedule.values()].filter(({ entry }) =>
        entry.player === player
        && entry.id.startsWith('reminder:')
        && entry.item.kind === 'reminder'
        && entry.item.firedAt === undefined).length;
    },
    async listDueScheduleEntries({ at, limit }) {
      const now = instantOf(at);
      return [...schedule.values()]
        .flatMap(({ entry }) => {
          const due = dueOf(entry);
          return due !== undefined && due <= now ? [{ player: entry.player, id: entry.id, due }] : [];
        })
        .sort((left, right) =>
          left.due - right.due || compareCodePoints(left.player, right.player) || compareCodePoints(left.id, right.id))
        .slice(0, Math.max(0, limit))
        .map(({ player, id }) => ({ player, id }));
    },
    async purge(cutoffs) {
      for (const cutoff of Object.values(cutoffs)) {
        instantOf(cutoff);
      }
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
