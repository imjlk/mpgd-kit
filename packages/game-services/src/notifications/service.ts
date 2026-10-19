import {
  assertNotificationConsentRecord,
  assertNotificationDeployment,
  assertNotificationEndpointRegistration,
  assertRecordNotificationNoticeInput,
  createNotificationNoticeIdempotencyKey,
  createNotificationReminderIdempotencyKey,
  evaluateNotificationDelivery,
  evaluateNotificationReminderConsent,
  isNotificationTimestamp,
  isSameNotificationNotice,
  isValidNotificationTimeZone,
  latestNotificationConsent,
  listNotificationNotices,
  normalizeNotificationTimestamp,
  NotificationError,
  notificationKeyIssue,
  notificationNoticeCopyIssues,
  notificationNoticeSendFrom,
  notificationNoticeTopic,
  notificationProviderCarriesNotices,
  notificationReservedKeyPrefix,
  notificationSendFingerprint,
  notificationTemplateDataIssue,
  toSeoulCalendarDate,
  type NotificationConsentRecord,
  type NotificationDeliveryDecision,
  type NotificationDeliveryHistoryEntry,
  type NotificationDeliveryOutcome,
  type NotificationDeliveryRefusal,
  type NotificationDeployment,
  type NotificationNotice,
  type NotificationNoticeIdentity,
  type NotificationPermissionState,
  type NotificationTemplateData,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import {
  fcmInstallationIdRefusal,
  notificationExpiredProviderCode,
  type NotificationRemoteDeliveryAnswer,
  type NotificationRemoteRecipient,
} from './delivery-provider.js';
import {
  notificationHistoryRetentionDays,
  type NotificationProviderRegistry,
  type NotificationProviderRegistrySnapshot,
  type NotificationServiceCatalog,
  type RegisteredNotificationProvider,
} from './registry.js';
import {
  bestNotificationOutcome,
  formatNotificationInstant,
  isNotificationRowAbandoned,
  isNotificationRowDue,
  notificationAmbiguousReplayHours,
  notificationSendOutcome,
  type NotificationConsentRecordInput,
  type NotificationNoticeChannel,
  type NotificationNoticeCheck,
  type NotificationPurgeCounts,
  type NotificationRateLimitState,
  type NotificationScheduleEntry,
  type NotificationSendOrigin,
  type NotificationSendRow,
  type NotificationStore,
  type NotificationStoredEndpoint,
  type NotificationStoredReminder,
  type NotificationStoredSend,
  type NotificationStoredSendRequest,
  type NotificationVersionedScheduleEntry,
} from './store.js';
import { describeError as describe } from './text.js';

/**
 * The notifications v2 server (RFC "Server"): consent records and the notices
 * API, the endpoint registry bound to the game-services session, and sends
 * through the idempotency ledger, the pure policy gate
 * (`evaluateNotificationDelivery` from `@mpgd/platform/notifications`), and
 * the delivery providers.
 *
 * - **Sessions.** Every player call names the authenticated session; the
 *   installation id is the session's, never a request field.
 * - **Sends.** A send is validated, bound to its fingerprint, and answered
 *   from its key state. A new key resolves its recipients (every usable
 *   endpoint of a device provider, or the platform identity), checks the gate
 *   once for each, and stores one row per recipient the gate allows or
 *   defers. Each allowed row is then a dispatch job: inline, or through the
 *   queue, and the gate runs again when the job makes the provider call.
 * - **Answers.** `accepted` delivers, `unregistered` invalidates the
 *   endpoint, `rate-limited` defers with backoff for at most 24 hours,
 *   `rejected` is not stored (with `agreement` it records a provider denial),
 *   and `ambiguous` keeps the claim for the lease.
 * - **Replays.** `dispatchDue` replays rows that came due: deferred rows, and
 *   every in-flight row whose lease ended (a queued job that was lost, a
 *   holder that failed before the call, an ambiguous answer). Ambiguous
 *   replays stop a day after the first attempt. A direct caller may also
 *   replay its own platform rows by sending the key again after the lease.
 *   Due rows go out at no more than each provider's registry `rate`, through
 *   the queue when one is bound and inline otherwise.
 * - **Scheduler.** `runScheduler` turns due server reminders into
 *   `reminder:` sends and, under the Korean rules, pushes each consent notice
 *   nobody recorded by seven days before its `dueBy` as a `notice:` send of
 *   the catalog's notice topic; both then leave as due rows. A refused
 *   notice push backs off, doubling from an hour to a day.
 * - **Consent history.** Each write compacts the player's history: records
 *   no rule reads any more are deleted a day after they were written.
 */

const secondMs = 1000;
const dayMs = 86_400 * secondMs;
const keyRetentionMs = 30 * dayMs;
const endpointStaleMs = 60 * dayMs;
const endpointPurgeDelayMs = 30 * dayMs;
const historyRetentionMs = notificationHistoryRetentionDays * dayMs;
const rateLimitGiveUpMs = dayMs;
const defaultRetryAfterSeconds = 60;
const defaultClaimLeaseSeconds = 300;
/** Conditional writes retried before a call answers that the ledger is busy. */
const maxLedgerAttempts = 8;
/** Settling an answer the provider already gave is retried harder, so it is not replayed. */
const maxCompleteAttempts = 24;
/** How long after the first attempt an ambiguous delivery is replayed. */
const ambiguousReplayMs = notificationAmbiguousReplayHours * 3_600_000;
/** The longest wait between ambiguous replays. */
const maxAmbiguousLeaseMs = 3_600_000;
/** Longest accepted text for ids, locales, links, and versions. */
const maxTextLength = 2048;
/** Longest accepted device address value. */
const maxAddressLength = 4096;
/** Longest row key: a send key, a colon, and an installation id that percent-encoding can grow ninefold. */
const maxRowKeyLength = maxTextLength + 1 + 9 * maxTextLength;
/** Largest consent evidence envelope, as JSON. */
const maxEvidenceBytes = 16_384;
/** How long a scheduler item waits after a failure that may pass. */
const schedulerRetryMs = 60 * secondMs;
/** How often a notice check looks again while a push of it waits in the ledger. */
const noticeRecheckMs = 3_600_000;
/** The first wait after a refused notice push; it doubles, up to a day. */
const noticeBackoffMs = 3_600_000;
/** Records no rule reads are kept this long, for the daily cap, and then deleted. */
const consentCompactionMs = dayMs;
/** Lists every notice still owed, now or later: the next re-confirmation of each consent. */
const noticeHorizon = '9999-12-31T00:00:00Z';
const noticesEntryId = 'notices';
/** How much wall time one scheduler run may use by default. */
const defaultSchedulerBudgetMs = 20_000;
const reminderEntryPrefix = 'reminder:';
const reminderEntryId = (key: string): string => `${reminderEntryPrefix}${key}`;
/** How far through the gate a set-time refusal got: the furthest step is the one answered. */
const reminderRefusalRank = {
  'permission-required': 1,
  'request-missing': 2,
  'preference-off': 2,
  'advertising-consent-missing': 3,
} as const;
/**
 * Client-written consent records a player may add per rolling day. It is
 * generous: it only stops a client that writes in a loop, since every send
 * reads the player's whole history. It is checked before the write, so
 * concurrent writes may pass it by a few.
 */
export const maxClientNotificationConsentRecordsPerDay = 200;
/**
 * Pending server reminders a player may keep, as many as iOS keeps local
 * notifications. Replacing a pending one is always allowed; a new key past
 * it answers `capacity-exceeded`. The count is read before the write, so
 * sets that race may pass it by a few, as the daily consent cap may.
 */
export const maxPendingNotificationReminders = 64;
/** How far ahead a server reminder may be set; a later `fireAt` is refused. */
export const notificationReminderHorizonDays = 90;

/** An authenticated game-services session, as the deployment's identity service resolves it. */
export interface NotificationSession {
  readonly player: string;
  /** Stable for the session's life (its refresh family); its end unbinds what it registered. */
  readonly sessionId: string;
  /** The guest session's installation id. */
  readonly installationId: string;
  /**
   * When the session ends on its own, RFC 3339; endpoints it registered
   * count as unbound from then. Each call moves their stored end to a later
   * one (or clears it when this is absent), never to an earlier one.
   */
  readonly expiresAt?: string;
}

/** A send request from the game's server (never from a client). */
export interface NotificationDeliverInput {
  readonly idempotencyKey: string;
  readonly player: string;
  readonly topic: string;
  /** One provider; without it the send goes to every provider the player has a recipient on. */
  readonly provider?: string;
  readonly templateData?: Readonly<Record<string, string | number | boolean>>;
  /** Untrusted routing data the open carries. */
  readonly data?: Readonly<Record<string, string>>;
  readonly locale?: string;
  /** A post or comment id for providers whose sends need one (Devvit). */
  readonly link?: string;
}

/** One recipient's delivery to run: a send key and its row. */
export interface NotificationDispatchJob {
  readonly sendKey: string;
  readonly provider: string;
  readonly rowKey: string;
}

/** A queue that runs each job later through `NotificationService.dispatch` (a Cloudflare Queue). */
export interface NotificationDispatchQueue {
  enqueue(jobs: readonly NotificationDispatchJob[]): Promise<void>;
}

export interface CreateNotificationServiceInput {
  readonly store: NotificationStore;
  readonly registry: NotificationProviderRegistry;
  readonly catalog: NotificationServiceCatalog;
  readonly deployment?: NotificationDeployment;
  /**
   * The recipient id of a platform-user provider for a player, from the
   * player's authenticated identity on that platform; `undefined` when the
   * player has none.
   */
  readonly resolvePlatformRecipient?: (input: {
    readonly provider: string;
    readonly player: string;
  }) => string | undefined | Promise<string | undefined>;
  /**
   * Runs dispatch jobs later, so a fan-out never exceeds one invocation's
   * subrequest limit. Without it every job runs inline before `deliver`
   * answers.
   */
  readonly queue?: NotificationDispatchQueue;
  readonly now?: () => string;
  /**
   * A monotonic clock in milliseconds that bounds one scheduler run's wall
   * time (`runScheduler`'s `budgetMs`); `performance.now()` by default.
   */
  readonly elapsedMs?: () => number;
  /** Jitter for repeated rate-limit backoff, in [0, 1). */
  readonly random?: () => number;
  /** How long a claim holds a delivery before another worker may replay it; 300 by default. */
  readonly claimLeaseSeconds?: number;
  /** Errors the service handles without failing the call, such as a queue that refused a job. */
  readonly onError?: (
    error: unknown,
    context: {
      readonly operation: string;
      readonly sendKey?: string;
      readonly provider?: string;
      readonly rowKey?: string;
      /**
       * True when the error is a delivery provider's own failure, whose
       * message may quote a device token or a credential: log its name only.
       */
      readonly fromProvider?: boolean;
    },
  ) => void;
}

export interface NotificationDueResult {
  readonly sendKey: string;
  /** The send's result after the replay. */
  readonly outcome: NotificationDeliveryOutcome;
}

/** A server reminder as a game sets it (RFC `reminders.set`, with the time already in the request). */
export interface NotificationReminderInput {
  readonly key: string;
  readonly topic: string;
  /** RFC 3339 with an explicit offset. */
  readonly fireAt: string;
  readonly templateData?: NotificationTemplateData;
  /** A post or comment id for providers whose sends need a link (Devvit). */
  readonly link?: string;
}

/** What setting a server reminder answers: stored, or the refusal of gate steps 3 to 5. */
export type NotificationReminderSetStatus =
  | 'scheduled'
  | 'replaced'
  | 'permission-required'
  | 'request-missing'
  | 'preference-off'
  | 'advertising-consent-missing'
  /** The player keeps `maxPendingNotificationReminders` pending reminders already. */
  | 'capacity-exceeded'
  /** No provider the player can be reached on maps the topic for its target. */
  | 'unavailable';

export interface NotificationService {
  /** The registry entries and served targets the backend publishes. */
  providers(): NotificationProviderRegistrySnapshot;
  /**
   * Appends a consent record for the session's player, dated by the backend.
   * A repeat of the player's latest permission, agreement, or preference
   * record for the same kind and topic answers that record unwritten; an
   * `advertising` or `night` record is always written, even a repeat, and
   * counts toward the cap. A player past
   * `maxClientNotificationConsentRecordsPerDay` gets a
   * `NotificationConsentRateLimitError`.
   */
  recordConsent(session: NotificationSession, record: unknown): Promise<NotificationConsentRecord>;
  listConsent(session: NotificationSession): Promise<readonly NotificationConsentRecord[]>;
  /**
   * Binds a device registration to the session's installation and player, or
   * keeps a platform-user registration's locale and zone. `target` names the
   * catalog target whose mapping applies to the device when two targets share
   * a provider (FCM on `android` and `ios`).
   */
  registerEndpoint(
    session: NotificationSession,
    input: { readonly registration: unknown; readonly target?: string },
  ): Promise<void>;
  /** Unbinds the session's installation from the session's player (one provider, or all). */
  unregisterEndpoint(session: NotificationSession, input?: { readonly provider?: string }): Promise<void>;
  /** The session ended (logout, revocation): every endpoint it registered is unbound. */
  endSession(input: { readonly sessionId: string }): Promise<void>;
  /** The session player's listed notices; none unless the deployment applies the Korean rules. */
  listNotices(session: NotificationSession): Promise<readonly NotificationNotice[]>;
  /** Records a listed notice the game showed; a notice that is not listed changes nothing. */
  recordNoticeShown(
    session: NotificationSession,
    notice: unknown,
    input?: { readonly channel?: Exclude<NotificationNoticeChannel, 'push'> },
  ): Promise<void>;
  /** One send through the ledger, the gate, and the providers. */
  deliver(input: unknown): Promise<NotificationDeliveryOutcome>;
  /** Runs one queued dispatch job; a job that is no longer due does nothing. */
  dispatch(job: NotificationDispatchJob): Promise<void>;
  /**
   * Replays up to `limit` sends with a due row, at no more than each
   * provider's registry `rate`: through the queue when one is bound (each
   * row is taken for its lease and enqueued), inline otherwise. One failing
   * send never stops the others.
   */
  dispatchDue(input?: { readonly limit?: number }): Promise<{
    readonly results: readonly NotificationDueResult[];
    readonly failed: number;
  }>;
  /**
   * Sets the session player's server reminder (RFC "Reminders"). Gate steps
   * 3 to 5 run first against the backend's records, the device permission
   * each endpoint reported, or the host read, for any provider the player
   * can be reached on; a refusal stores nothing. Otherwise the reminder with
   * this key is stored or replaced, and a send of the previous one that
   * still waits (deferred or in flight) is stopped.
   */
  setReminder(
    session: NotificationSession,
    input: unknown,
  ): Promise<{ readonly status: NotificationReminderSetStatus }>;
  /**
   * Removes the session player's reminder with this key and stops a send of
   * it that still waits; answers whether either existed.
   */
  cancelReminder(session: NotificationSession, input: unknown): Promise<{ readonly cancelled: boolean }>;
  /**
   * One scheduler run, in rounds: each takes up to `limit` due schedule
   * entries (server reminders become `reminder:` sends; each player's notice
   * check pushes the consent notices owed by now), then `dispatchDue` with
   * the same `limit`. Rounds go on while a round filled a batch and got
   * somewhere, until `budgetMs` of wall time (20 seconds by default) is used.
   * Answers each send it touched with its result after the run, in the order
   * it first touched them.
   */
  runScheduler(input?: { readonly limit?: number; readonly budgetMs?: number }): Promise<{
    readonly results: readonly NotificationDueResult[];
    readonly failed: number;
  }>;
  /** Forgets keys after 30 days, the history past the limit windows, and dead or stale endpoints. */
  purge(): Promise<NotificationPurgeCounts>;
}

/**
 * A player wrote more consent records than one rolling day allows. It is
 * retryable after `retryAfterSeconds`, when the oldest counted record leaves
 * the window.
 */
export class NotificationConsentRateLimitError extends NotificationError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
      message: `Too many consent records today; retry in ${retryAfterSeconds} s.`,
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A gate caller error (such as missing template data): the send cannot be made as asked. */
class NotificationSendInputError extends Error {
  override readonly name = 'NotificationSendInputError';
}

/**
 * The provider accepted or may have sent, but storing its answer failed. It
 * is retryable for the caller, who answers from the ledger by the same key;
 * the row itself recovers through the due replay once its lease ends, since
 * a queue job never replays an attempted row.
 */
class NotificationSettleError extends NotificationError {
  constructor(options: { readonly cause: unknown }) {
    super('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
      message: 'The provider answered, but the answer could not be stored; the send key answers from the ledger.',
      cause: options.cause,
    });
  }
}

interface Recipient {
  readonly provider: RegisteredNotificationProvider;
  readonly rowKey: string;
  readonly installationId?: string;
  readonly endpoint?: NotificationStoredEndpoint;
  readonly platformId?: string;
  readonly resolved: boolean;
  readonly target?: string;
  readonly locale?: string;
  readonly timeZone?: string;
}

type RowChange =
  | { readonly kind: 'remove' }
  | { readonly kind: 'set'; readonly row: NotificationSendRow };

type RunMode = 'job' | 'retry' | 'due';

export function createNotificationService(input: CreateNotificationServiceInput): NotificationService {
  const { store, registry, catalog } = input;
  const deployment = input.deployment === undefined
    ? undefined
    : assertNotificationDeployment(input.deployment);
  const rules = deployment?.advertisingRules ?? 'none';
  const leaseSeconds = input.claimLeaseSeconds ?? defaultClaimLeaseSeconds;
  // Checked in seconds: 0.5 is a whole number of milliseconds but no lease.
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds * secondMs > dayMs) {
    throw new TypeError('claimLeaseSeconds must be a whole number of seconds up to one day.');
  }
  const leaseMs = leaseSeconds * secondMs;
  /** The claim lease after `attempts` ambiguous attempts: doubling, up to an hour (or the lease, if longer). */
  const ambiguousLeaseMs = (attempts: number): number =>
    Math.min(leaseMs * 2 ** Math.min(attempts, 16), Math.max(leaseMs, maxAmbiguousLeaseMs));
  const random = input.random ?? Math.random;
  const noticeTopic = catalog.notices?.topic;
  if (catalog.notices !== undefined) {
    const issues = notificationNoticeCopyIssues(catalog.notices.copy, catalog.defaultLocale);
    if (typeof noticeTopic !== 'string' || noticeTopic.length === 0 || issues.length > 0) {
      throw new TypeError(
        `The catalog's notices block needs its topic and copy by the catalog rules: ${issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      );
    }
  }
  const longestWindowMs = Math.max(
    dayMs,
    ...registry.providers.flatMap((provider) =>
      (provider.entry.limits ?? []).map((limit) => limit.windowSeconds * secondMs)),
  );
  const nowMs = (): number => {
    const at = (input.now ?? (() => new Date().toISOString()))();
    return Date.parse(normalizeNotificationTimestamp(at));
  };
  const report = (
    error: unknown,
    operation: string,
    context: string | { readonly sendKey: string; readonly provider?: string; readonly rowKey?: string } = {
      sendKey: '',
    },
    fromProvider = false,
  ): void => {
    const where = typeof context === 'string' ? { sendKey: context } : context;
    try {
      input.onError?.(error, {
        operation,
        ...(where.sendKey === '' ? {} : { sendKey: where.sendKey }),
        ...(where.provider === undefined ? {} : { provider: where.provider }),
        ...(where.rowKey === undefined ? {} : { rowKey: where.rowKey }),
        ...(fromProvider ? { fromProvider } : {}),
      });
    } catch {
      // A failing error hook must not change the call's answer.
    }
  };

  // Topics.

  /** The topic as declared for the recipient's target, else for the provider's first target that declares it. */
  const topicFor = (
    provider: RegisteredNotificationProvider,
    target: string | undefined,
    topicId: string,
    origin: NotificationSendOrigin,
  ): NotificationTopicDeclaration | undefined => {
    const targets = target !== undefined && provider.targets.includes(target)
      ? [target]
      : provider.targets;
    for (const candidate of targets) {
      const topic = catalog.topicsFor(candidate).find((declared) => declared.id === topicId);
      if (topic !== undefined) {
        // A notice says only its variant of notices.copy.
        return origin.kind === 'notice' && catalog.notices !== undefined
          ? notificationNoticeTopic(topic, catalog.notices.copy, origin.variant)
          : topic;
      }
    }
    return undefined;
  };
  const refuseNoticeTopic = (topic: string): void => {
    if (noticeTopic !== undefined && topic === noticeTopic) {
      throw invalidInput(
        `Topic ${topic} is reserved for consent notices, which only the scheduler sends.`,
      );
    }
  };

  // Notices.

  const noticesOf = async (player: string, at: number): Promise<readonly NotificationNotice[]> =>
    rules === 'kr'
      ? listNotificationNotices(
          await store.listConsent(player),
          await store.listNoticesGiven(player),
          formatNotificationInstant(at),
        )
      : [];
  const noticeListed = async (
    player: string,
    notice: NotificationNoticeIdentity,
    at: number,
  ): Promise<boolean> =>
    (await noticesOf(player, at)).some((listed) => isSameNotificationNotice(listed, notice));

  // Recipients (gate step 2).

  const usable = (endpoint: NotificationStoredEndpoint, at: number): boolean =>
    endpoint.status === 'valid'
    && at - Date.parse(endpoint.lastRegisteredAt) < endpointStaleMs
    && (endpoint.sessionExpiresAt === undefined || Date.parse(endpoint.sessionExpiresAt) > at);
  const deviceRecipient = (
    provider: RegisteredNotificationProvider,
    sendKey: string,
    endpoint: NotificationStoredEndpoint,
  ): Recipient => ({
    provider,
    rowKey: `${sendKey}:${encodeURIComponent(endpoint.installationId)}`,
    installationId: endpoint.installationId,
    endpoint,
    resolved: true,
    ...(endpoint.target === undefined ? {} : { target: endpoint.target }),
    ...(endpoint.locale === undefined ? {} : { locale: endpoint.locale }),
    ...(endpoint.timeZone === undefined ? {} : { timeZone: endpoint.timeZone }),
  });
  const platformRecipient = async (
    provider: RegisteredNotificationProvider,
    request: NotificationStoredSendRequest,
  ): Promise<Recipient> => {
    let id: string | undefined;
    try {
      id = await input.resolvePlatformRecipient?.({
        provider: provider.entry.provider,
        player: request.player,
      });
    } catch (error) {
      // An identity service that cannot answer now is retried, as a host read is.
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `The platform recipient of provider ${provider.entry.provider} could not be resolved.`,
        cause: error,
      });
    }
    const registration = await store.getPlatformRegistration({
      player: request.player,
      provider: provider.entry.provider,
    });
    const platformId = typeof id === 'string' && id.length > 0 ? id : undefined;
    return {
      provider,
      rowKey: request.idempotencyKey,
      ...(platformId === undefined ? {} : { platformId }),
      resolved: platformId !== undefined,
      ...(registration?.locale === undefined ? {} : { locale: registration.locale }),
      ...(registration?.timeZone === undefined ? {} : { timeZone: registration.timeZone }),
    };
  };
  /**
   * Every recipient of a send: one per usable endpoint (installation-id
   * order) of each device provider, the platform identity of each
   * platform-user provider, over the named provider or every provider. When
   * no provider has a recipient, one unresolved recipient per provider, so
   * the gate still answers its earlier steps (`topic-unknown` before
   * `no-endpoint`). A consent notice goes only through providers that can
   * carry it (`notificationProviderCarriesNotices`).
   */
  const recipientsOf = async (
    request: NotificationStoredSendRequest,
    at: number,
    origin: NotificationSendOrigin,
  ): Promise<readonly Recipient[]> => {
    let scope: readonly RegisteredNotificationProvider[] = registry.providers;
    if (request.provider !== undefined) {
      const named = registry.provider(request.provider);
      scope = named === undefined ? [] : [named];
    }
    if (origin.kind === 'notice') {
      scope = scope.filter((provider) => notificationProviderCarriesNotices(provider.entry));
    }
    // Providers are independent: resolve them together, then keep the order.
    const perProvider = await Promise.all(scope.map(async (provider): Promise<readonly Recipient[]> => {
      if (provider.entry.addressing !== 'device') {
        return [await platformRecipient(provider, request)];
      }
      const endpoints = (await store.listEndpoints({
        player: request.player,
        provider: provider.entry.provider,
      }))
        .filter((endpoint) => usable(endpoint, at))
        .sort((left, right) => compareText(left.installationId, right.installationId));
      return endpoints.length === 0
        ? [{ provider, rowKey: request.idempotencyKey, resolved: false }]
        : endpoints.map((endpoint) => deviceRecipient(provider, request.idempotencyKey, endpoint));
    }));
    const resolved = perProvider.flat().filter((recipient) => recipient.resolved);
    const unresolved = perProvider.flat().filter((recipient) => !recipient.resolved);
    return resolved.length > 0 ? resolved : unresolved;
  };
  /** A stored row's recipient on replay: its endpoint now, unresolved once it is gone or moved. */
  const recipientOfRow = async (
    provider: RegisteredNotificationProvider,
    request: NotificationStoredSendRequest,
    row: NotificationSendRow,
    at: number,
  ): Promise<Recipient> => {
    if (row.installationId === undefined) {
      return platformRecipient(provider, request);
    }
    const endpoint = await store.getEndpoint({
      provider: provider.entry.provider,
      installationId: row.installationId,
    });
    return endpoint !== undefined && endpoint.player === request.player && usable(endpoint, at)
      ? deviceRecipient(provider, request.idempotencyKey, endpoint)
      : { provider, rowKey: row.key, installationId: row.installationId, resolved: false };
  };

  // Gate inputs.

  /**
   * The sends the gate counts for a recipient on `provider`, oldest first,
   * within the longest limit window: delivered sends, and sends another
   * holder is sending or may have sent (an attempted in-flight row). Each
   * send counts once, on `provider` when it reached it there, so one send
   * delivered through two providers is one send for the topic's cap. The
   * send being made is left out, including its earlier delivery to another
   * endpoint, and so is an in-flight send claimed after `self`: of two sends
   * claimed together, the earlier one (then the lower key) is the one the
   * other counts, so a cap of one still lets one through. A claim counts
   * from the moment it is taken, before its own gate has run: a send the
   * gate then holds can defer another for a while, which is the price of
   * never letting two through a cap of one.
   */
  const loadHistory = async (
    player: string,
    excluding: string,
    at: number,
    self?: { readonly key: string; readonly claimedAt: number },
  ): Promise<SendHistory> => {
    const bySend = new Map<string, NotificationDeliveryHistoryEntry[]>();
    const add = (sendKey: string, entry: NotificationDeliveryHistoryEntry): void => {
      bySend.set(sendKey, [...(bySend.get(sendKey) ?? []), entry]);
    };
    for (const sent of await store.listHistory({
      player,
      since: formatNotificationInstant(at - longestWindowMs),
    })) {
      if (sent.sendKey !== excluding) {
        add(sent.sendKey, { provider: sent.provider, topic: sent.topic, at: sent.at });
      }
    }
    for (const send of await store.listInFlightSends(player)) {
      if (send.key === excluding) {
        continue;
      }
      for (const row of send.rows) {
        if (row.state.status !== 'in-flight' || !row.state.attempted) {
          continue;
        }
        const claimedAt = Date.parse(row.state.attemptedAt ?? send.changedAt);
        if (
          self !== undefined
          && (claimedAt > self.claimedAt || (claimedAt === self.claimedAt && send.key > self.key))
        ) {
          continue;
        }
        add(send.key, {
          provider: row.provider,
          topic: send.request.topic,
          at: formatNotificationInstant(claimedAt),
        });
      }
    }
    return bySend;
  };
  const readServerPermission = async (
    provider: RegisteredNotificationProvider,
    request: NotificationStoredSendRequest,
  ): Promise<NotificationPermissionState | undefined> => {
    if (!provider.entry.permission.serverReadable) {
      return undefined;
    }
    try {
      const state = await provider.delivery.readPermission?.({
        player: request.player,
        topic: request.topic,
      });
      if (state === undefined) {
        throw new TypeError(`Provider ${provider.entry.provider} answered no permission.`);
      }
      return state;
    } catch (error) {
      // A host that cannot answer now is retried, whatever the error's class.
      throw new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
        message: `The host could not answer the send-time permission read for provider ${provider.entry.provider}.`,
        cause: error,
      });
    }
  };
  /**
   * For a provider whose permission the server reads, the gate's answer
   * when a step before the permission step refuses (the topic, the channel,
   * the purpose, the recipient, the link): that answer needs no host read,
   * so a host outage cannot turn it into a retry. `evaluate` runs the gate
   * with a stand-in permission, which only the later steps read; its history
   * and time do not matter to the earlier ones. Any other answer, or an
   * error, means the real read decides.
   */
  const earlyRefusal = (
    provider: RegisteredNotificationProvider,
    evaluate: (standIn: NotificationPermissionState) => ReturnType<typeof decide>,
  ): ReturnType<typeof decide> | undefined => {
    if (!provider.entry.permission.serverReadable) {
      return undefined;
    }
    let early: ReturnType<typeof decide>;
    try {
      early = evaluate('granted');
    } catch {
      return undefined;
    }
    return early.decision.status !== 'allowed' && earlyGateReasons.has(early.decision.reason)
      ? early
      : undefined;
  };
  const decide = (
    request: NotificationStoredSendRequest,
    origin: NotificationSendOrigin,
    recipient: Recipient,
    consent: readonly NotificationConsentRecord[],
    history: readonly NotificationDeliveryHistoryEntry[],
    serverPermission: NotificationPermissionState | undefined,
    at: number,
  ): { readonly decision: NotificationDeliveryDecision; readonly topic: NotificationTopicDeclaration | undefined } => {
    const topic = topicFor(recipient.provider, recipient.target, request.topic, origin);
    const locale = request.locale ?? recipient.locale;
    try {
      return {
        topic,
        decision: evaluateNotificationDelivery({
          entry: recipient.provider.entry,
          ...(deployment === undefined ? {} : { deployment }),
          topic,
          recipientResolved: recipient.resolved,
          ...(request.link === undefined ? {} : { link: request.link }),
          consent,
          ...(serverPermission === undefined ? {} : { serverPermission }),
          ...(recipient.endpoint === undefined ? {} : { endpointPermission: recipient.endpoint.permission }),
          history,
          at: formatNotificationInstant(at),
          ...(recipient.timeZone === undefined ? {} : { timeZone: recipient.timeZone }),
          ...(locale === undefined ? {} : { locale }),
          defaultLocale: catalog.defaultLocale,
          ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
        }),
      };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new NotificationSendInputError(error.message, { cause: error });
      }
      throw error;
    }
  };

  // Ledger.

  const newToken = (): string => globalThis.crypto.randomUUID();
  /** A stored send, unless its retention ended (then it is forgotten). */
  const lookup = async (key: string, at: number) => {
    const held = await store.getSend(key);
    if (held !== undefined && at - Date.parse(held.send.changedAt) >= keyRetentionMs) {
      await store.updateSend({ key, version: held.version, send: undefined });
      return undefined;
    }
    return held;
  };
  const rowsWith = (
    send: NotificationStoredSend,
    row: NotificationSendRow,
    change: RowChange,
  ): NotificationSendRow[] =>
    send.rows.flatMap((candidate) => {
      if (candidate.key !== row.key || candidate.provider !== row.provider) {
        return [candidate];
      }
      return change.kind === 'remove' ? [] : [change.row];
    });
  const nextRateLimit = (
    prior: NotificationRateLimitState | undefined,
    retryAfterSeconds: number | undefined,
    at: number,
  ): { readonly until: string; readonly state: NotificationRateLimitState } | undefined => {
    const since = prior === undefined ? at : Date.parse(prior.since);
    const deadline = since + rateLimitGiveUpMs;
    if (at >= deadline) {
      return undefined;
    }
    const answered = retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : undefined;
    const delaySeconds = prior?.delaySeconds ?? answered ?? defaultRetryAfterSeconds;
    const attempts = prior?.attempts ?? 0;
    // The first deferral waits the provider's delay; later ones back off
    // exponentially from it, with up to 25% jitter so retries spread out, and
    // never wait less than the provider asks this time.
    const draw = random();
    const jitter = attempts === 0 || !Number.isFinite(draw)
      ? 1
      : 1 + Math.min(Math.max(draw, 0), 0.999) * 0.25;
    const delayMs = Math.max(
      delaySeconds * 2 ** attempts * secondMs * jitter,
      (answered ?? 0) * secondMs,
    );
    return {
      until: formatNotificationInstant(Math.min(Math.ceil(at + delayMs), deadline)),
      state: { since: formatNotificationInstant(since), delaySeconds, attempts: attempts + 1 },
    };
  };
  const callProvider = async (
    recipient: Recipient,
    request: NotificationStoredSendRequest,
    topic: NotificationTopicDeclaration,
    decision: Extract<NotificationDeliveryDecision, { readonly status: 'allowed' }>,
    at: number,
  ): Promise<NotificationRemoteDeliveryAnswer> => {
    const mappedLink = topic.mapping?.['link'];
    const link = request.link ?? (typeof mappedLink === 'string' ? mappedLink : undefined);
    const target: NotificationRemoteRecipient = recipient.endpoint !== undefined
      ? {
          kind: 'device',
          installationId: recipient.endpoint.installationId,
          address: recipient.endpoint.address,
        }
      : { kind: 'platform-user', id: recipient.platformId ?? '' };
    const locale = request.locale ?? recipient.locale;
    try {
      const answer: unknown = await recipient.provider.delivery.send({
        idempotencyKey: recipient.rowKey,
        sendKey: request.idempotencyKey,
        provider: recipient.provider.entry.provider,
        player: request.player,
        topic,
        recipient: target,
        content: decision.content,
        ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
        ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
        ...(request.data === undefined ? {} : { data: request.data }),
        ...(link === undefined ? {} : { link }),
        ...(locale === undefined ? {} : { locale }),
        at: formatNotificationInstant(at),
      });
      const known = deliveryAnswerOf(answer);
      if (known === undefined) {
        // A provider that broke the contract may still have sent it.
        report(
          new TypeError('The provider answered no known delivery answer.'),
          'provider.send',
          request.idempotencyKey,
        );
        return { status: 'ambiguous' };
      }
      return known;
    } catch (error) {
      // The provider may have sent it: one rule for every failure it cannot prove.
      report(error, 'provider.send', request.idempotencyKey, true);
      return { status: 'ambiguous' };
    }
  };

  /**
   * The rows a new send stores, after a first gate check per recipient:
   * allowed recipients become queued rows, deferred ones deferred rows, and
   * refusals are answered but not stored. A caller error throws before
   * anything is stored. A queued row's lease ends a claim lease from now, or
   * at `queuedUntil` for a scheduler item, whose rows are due at once and
   * leave through the paced due path.
   */
  const plan = async (
    request: NotificationStoredSendRequest,
    origin: NotificationSendOrigin,
    at: number,
    queuedUntil?: number,
  ): Promise<{ readonly rows: NotificationSendRow[]; readonly refusals: NotificationDeliveryRefusal[] }> => {
    const recipients = await recipientsOf(request, at, origin);
    if (recipients.length === 0) {
      return { rows: [], refusals: [noEndpoint()] };
    }
    const consent = await store.listConsent(request.player);
    const history = await loadHistory(request.player, request.idempotencyKey, at);
    const perProvider = new Map<string, {
      permission?: Promise<NotificationPermissionState | undefined>;
      readonly history: NotificationDeliveryHistoryEntry[];
    }>();
    const rows: NotificationSendRow[] = [];
    const refusals: NotificationDeliveryRefusal[] = [];
    for (const recipient of recipients) {
      const id = recipient.provider.entry.provider;
      let inputs = perProvider.get(id);
      if (inputs === undefined) {
        inputs = { history: historyOn(history, id) };
        perProvider.set(id, inputs);
      }
      const held = inputs;
      const evaluate = (permission: NotificationPermissionState | undefined) =>
        decide(request, origin, recipient, consent, held.history, permission, at);
      // One read per provider and send, made only once a recipient needs it.
      const { decision } = earlyRefusal(recipient.provider, evaluate)
        ?? evaluate(await (held.permission ??= readServerPermission(recipient.provider, request)));
      const row = {
        key: recipient.rowKey,
        provider: id,
        ...(recipient.installationId === undefined ? {} : { installationId: recipient.installationId }),
      };
      if (decision.status === 'deferred') {
        rows.push({
          ...row,
          state: { status: 'deferred', reason: decision.reason, until: decision.until },
        });
      } else if (decision.status === 'allowed') {
        rows.push({
          ...row,
          state: {
            status: 'in-flight',
            leaseUntil: formatNotificationInstant(queuedUntil ?? at + leaseMs),
            attempted: false,
          },
        });
      } else {
        refusals.push(decision);
      }
    }
    return { rows, refusals };
  };

  const eligible = (mode: RunMode, row: NotificationSendRow, at: number): boolean => {
    switch (mode) {
      case 'job':
        // A queued delivery runs once: a row no holder claims, either never
        // sent or taken from the due rows for the queue. An attempted row
        // keeps its claim, so it is replayed only after its lease, and never
        // once its replays ended a day after the first attempt.
        return row.state.status === 'in-flight'
          && row.state.claim === undefined
          && !(row.state.attempted
            && row.firstAttemptedAt !== undefined
            && at - Date.parse(row.firstAttemptedAt) >= ambiguousReplayMs);
      case 'retry':
        // A direct caller replays its own platform rows once their lease ended.
        return row.state.status === 'in-flight'
          && row.installationId === undefined
          && isNotificationRowDue(row, at);
      case 'due':
        return isNotificationRowDue(row, at);
    }
  };

  /**
   * Applies a row change while this claim still holds the row; a stale claim
   * changes nothing. Conditional writes that lose to another row of the same
   * send are retried with a jittered backoff, so a fan-out's workers settle
   * one after the other.
   */
  const complete = async (
    sendKey: string,
    claimed: NotificationSendRow,
    token: string,
    change: RowChange,
    at: number,
  ): Promise<void> => {
    for (let attempt = 0; attempt < maxCompleteAttempts; attempt += 1) {
      if (attempt > 0) {
        const draw = random();
        await pause((Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0.5) * 10 * attempt);
      }
      const held = await store.getSend(sendKey);
      const row = held?.send.rows.find((candidate) =>
        candidate.key === claimed.key && candidate.provider === claimed.provider);
      if (
        held === undefined
        || row === undefined
        || row.state.status !== 'in-flight'
        || row.state.claim !== token
      ) {
        // Another holder took the row after the lease: its answer stands.
        return;
      }
      const rows = rowsWith(held.send, row, change);
      const wasDelivered = notificationSendOutcome(held.send)?.status === 'delivered';
      const next: NotificationStoredSend | undefined = rows.length === 0
        ? undefined
        : { ...held.send, rows, changedAt: formatNotificationInstant(at) };
      if (await store.updateSend({ key: sendKey, version: held.version, send: next })) {
        if (
          !wasDelivered
          && next !== undefined
          && notificationSendOutcome(next)?.status === 'delivered'
          && next.origin.kind === 'notice'
          && await noticeListed(next.request.player, next.origin.notice, at)
        ) {
          // A notice the scheduler sent is recorded once it is delivered.
          await store.addNoticeGiven({
            ...next.origin.notice,
            player: next.request.player,
            channel: 'push',
            at: formatNotificationInstant(at),
          });
        }
        return;
      }
    }
    throw busy(sendKey);
  };

  /**
   * Claims one row, runs the gate for it immediately before the provider
   * call, and stores the answer. Answers the row's refusal, if any.
   */
  const runRow = async (
    sendKey: string,
    provider: string,
    rowKey: string,
    mode: RunMode,
  ): Promise<{ readonly refusal?: NotificationDeliveryRefusal }> => {
    let claimed: {
      readonly send: NotificationStoredSend;
      readonly before: NotificationSendRow;
      readonly row: NotificationSendRow;
      readonly token: string;
      readonly at: number;
    } | undefined;
    for (let attempt = 0; attempt < maxLedgerAttempts && claimed === undefined; attempt += 1) {
      const at = nowMs();
      const held = await store.getSend(sendKey);
      const row = held?.send.rows.find((candidate) =>
        candidate.key === rowKey && candidate.provider === provider);
      if (held === undefined || row === undefined || !eligible(mode, row, at)) {
        return {};
      }
      if (
        held.send.origin.kind === 'notice'
        && !await noticeListed(held.send.request.player, held.send.origin.notice, at)
      ) {
        // The game gave the notice while the push waited: it is not sent again.
        const rows = rowsWith(held.send, row, { kind: 'remove' });
        await store.updateSend({
          key: sendKey,
          version: held.version,
          send: rows.length === 0
            ? undefined
            : { ...held.send, rows, changedAt: formatNotificationInstant(at) },
        });
        return {};
      }
      const token = newToken();
      // The replay window opens at the first claim that may reach the
      // provider; paths that prove nothing was sent write the earlier value back.
      // A replay of a row that may have been sent (an ambiguous answer, or a
      // holder that died mid-call) counts as one more ambiguous attempt, so
      // its lease grows with each replay either way.
      const replayed = row.state.status === 'in-flight' && row.state.attempted;
      const ambiguousAttempts = (row.ambiguousAttempts ?? 0) + (replayed ? 1 : 0);
      const claimedRow: NotificationSendRow = {
        ...row,
        firstAttemptedAt: row.firstAttemptedAt ?? formatNotificationInstant(at),
        ...(ambiguousAttempts === 0 ? {} : { ambiguousAttempts }),
        state: {
          status: 'in-flight',
          leaseUntil: formatNotificationInstant(at + ambiguousLeaseMs(ambiguousAttempts)),
          claim: token,
          attempted: true,
          attemptedAt: formatNotificationInstant(at),
        },
      };
      const next: NotificationStoredSend = {
        ...held.send,
        // A due replay marks the send as the scheduler's.
        scheduled: held.send.scheduled || mode === 'due',
        rows: rowsWith(held.send, row, { kind: 'set', row: claimedRow }),
        changedAt: formatNotificationInstant(at),
      };
      if (await store.updateSend({ key: sendKey, version: held.version, send: next })) {
        claimed = { send: next, before: row, row: claimedRow, token, at };
      }
    }
    if (claimed === undefined) {
      throw busy(sendKey);
    }
    const { send, before, row, token } = claimed;
    const registered = registry.provider(row.provider);
    if (registered === undefined) {
      // The deployment no longer serves this provider.
      await complete(sendKey, row, token, { kind: 'remove' }, claimed.at);
      return { refusal: noEndpoint() };
    }
    let evaluated: ReturnType<typeof decide>;
    let recipient: Recipient;
    let at: number;
    try {
      recipient = await recipientOfRow(registered, send.request, row, claimed.at);
      const consent = await store.listConsent(send.request.player);
      const early = earlyRefusal(registered, (standIn) =>
        decide(send.request, send.origin, recipient, consent, [], standIn, nowMs()),
      );
      const serverPermission = early === undefined
        ? await readServerPermission(registered, send.request)
        : undefined;
      at = nowMs();
      evaluated = early ?? decide(
        send.request,
        send.origin,
        recipient,
        consent,
        historyOn(
          await loadHistory(send.request.player, sendKey, at, { key: sendKey, claimedAt: claimed.at }),
          row.provider,
        ),
        serverPermission,
        at,
      );
    } catch (error) {
      if (error instanceof NotificationSendInputError) {
        // A send that cannot be made as asked fails once, not on every replay.
        await settleQuietly(sendKey, row, token, { kind: 'remove' }, claimed.at);
        throw invalidInput(error.message, error);
      }
      // Nothing was sent (a host read or the store failed): the row goes back
      // as it was, due again after a short backoff so a failing host does not
      // fill every scheduler batch.
      await settleQuietly(
        sendKey,
        row,
        token,
        { kind: 'set', row: backedOff(before, nowMs()) },
        claimed.at,
      );
      throw error;
    }
    const { decision, topic } = evaluated;
    const backoff = row.rateLimit === undefined ? {} : { rateLimit: row.rateLimit };
    const base = {
      key: row.key,
      provider: row.provider,
      ...(row.installationId === undefined ? {} : { installationId: row.installationId }),
      ...(before.firstAttemptedAt === undefined ? {} : { firstAttemptedAt: before.firstAttemptedAt }),
      ...(before.ambiguousAttempts === undefined ? {} : { ambiguousAttempts: before.ambiguousAttempts }),
    };
    if (decision.status === 'deferred') {
      await complete(
        sendKey,
        row,
        token,
        {
          kind: 'set',
          row: {
            ...base,
            ...backoff,
            state: { status: 'deferred', reason: decision.reason, until: decision.until },
          },
        },
        at,
      );
      return {};
    }
    if (decision.status !== 'allowed' || topic === undefined) {
      await complete(sendKey, row, token, { kind: 'remove' }, at);
      return { refusal: decision.status === 'allowed' ? noEndpoint() : decision };
    }
    const answer = await callProvider(recipient, send.request, topic, decision, at);
    const answeredAt = nowMs();
    switch (answer.status) {
      case 'accepted':
        // Counted before the row is settled: the provider took it whatever
        // happens next. A history write that keeps failing is reported, and
        // the row still settles as delivered: an undercounted limit is
        // better than a replay that sends the push twice.
        await withRetries(
          () =>
            store.addHistory({
              sendKey,
              provider: row.provider,
              player: send.request.player,
              topic: send.request.topic,
              at: formatNotificationInstant(answeredAt),
            }),
          (error) =>
            report(error, 'history.add', { sendKey, provider: row.provider, rowKey: row.key }),
        );
        await settleAfterCall(
          sendKey,
          row,
          token,
          { kind: 'set', row: { ...base, state: { status: 'delivered' } } },
          answeredAt,
        );
        return {};
      case 'ambiguous': {
        // The provider may have sent it: the claim is kept for the lease.
        const kept = row.state.status === 'in-flight' ? row.state : undefined;
        // The first replay waits the claim lease, and each later ambiguous
        // answer doubles the wait, up to an hour: a provider without an
        // idempotency key may show every replay. The next claim counts the replay.
        const ambiguousAttempts = row.ambiguousAttempts ?? 0;
        const leaseUntil = answeredAt + ambiguousLeaseMs(ambiguousAttempts);
        // The replay window started at the claim that reached the provider (or an earlier one).
        const firstAttemptedAt = row.firstAttemptedAt ?? formatNotificationInstant(at);
        if (isNotificationRowAbandoned({ ...row, firstAttemptedAt }, leaseUntil)) {
          report(
            new Error(
              'Ambiguous answers for a day: the delivery stays in flight and is not replayed again.',
            ),
            'dispatch.abandoned',
            { sendKey, provider: row.provider, rowKey: row.key },
          );
        }
        await settleAfterCall(
          sendKey,
          row,
          token,
          {
            kind: 'set',
            row: {
              ...base,
              ...backoff,
              firstAttemptedAt,
              ...(ambiguousAttempts === 0 ? {} : { ambiguousAttempts }),
              state: {
                status: 'in-flight',
                leaseUntil: formatNotificationInstant(leaseUntil),
                claim: token,
                attempted: true,
                ...(kept?.attemptedAt === undefined ? {} : { attemptedAt: kept.attemptedAt }),
              },
            },
          },
          answeredAt,
        );
        return {};
      }
      case 'unregistered':
        if (recipient.endpoint !== undefined) {
          await store.invalidateEndpoint({
            provider: row.provider,
            installationId: recipient.endpoint.installationId,
            value: recipient.endpoint.address.value,
            at: formatNotificationInstant(answeredAt),
          });
        }
        await complete(sendKey, row, token, { kind: 'remove' }, answeredAt);
        return { refusal: { status: 'unavailable', reason: 'endpoint-invalid' } };
      case 'rejected':
        // A configuration rejection fails every send the same way: tell the
        // operator. A recipient or agreement refusal is the player's, and a
        // message that would arrive too late is routine; neither is an alert.
        if (answer.reason === 'configuration' && answer.providerCode !== notificationExpiredProviderCode) {
          report(
            new Error(
              `The provider rejected the delivery (configuration${
                answer.providerCode === undefined ? '' : `, ${answer.providerCode}`
              }).`,
            ),
            'provider.rejected',
            { sendKey, provider: row.provider, rowKey: row.key },
          );
        }
        if (answer.reason === 'agreement') {
          await recordProviderDenial(send.request.player, send.request.topic, answeredAt);
        }
        await complete(sendKey, row, token, { kind: 'remove' }, answeredAt);
        return { refusal: { status: 'unavailable', reason: 'provider-rejected' } };
      case 'rate-limited': {
        // Nothing was sent: the claim is released and the row waits.
        const next = nextRateLimit(row.rateLimit, answer.retryAfterSeconds, answeredAt);
        if (next === undefined) {
          await complete(sendKey, row, token, { kind: 'remove' }, answeredAt);
          return { refusal: { status: 'unavailable', reason: 'provider-rate-limited' } };
        }
        await complete(
          sendKey,
          row,
          token,
          {
            kind: 'set',
            row: {
              ...base,
              rateLimit: next.state,
              state: { status: 'deferred', reason: 'provider-rate-limited', until: next.until },
            },
          },
          answeredAt,
        );
        return {};
      }
    }
  };

  /**
   * `complete` after the provider accepted or answered ambiguously: a
   * failure here leaves a delivery that may have happened, which is not the
   * same as nothing sent, so it is marked for `runInline`.
   */
  const settleAfterCall = async (
    sendKey: string,
    row: NotificationSendRow,
    token: string,
    change: RowChange,
    at: number,
  ): Promise<void> => {
    try {
      await complete(sendKey, row, token, change, at);
    } catch (error) {
      throw new NotificationSettleError({ cause: error });
    }
  };

  /** `complete` on a failure path: its own failure is reported, never thrown over the original. */
  const settleQuietly = async (
    sendKey: string,
    row: NotificationSendRow,
    token: string,
    change: RowChange,
    at: number,
  ): Promise<void> => {
    try {
      await complete(sendKey, row, token, change, at);
    } catch (error) {
      report(error, 'ledger.release', sendKey);
    }
  };

  /**
   * The host says the recipient has not agreed: a topic that needs an
   * agreement stops until the player agrees again. A denial already latest
   * for the topic is not written again, so repeated refusals of a topic that
   * needs no agreement do not grow the history. Two refusals settled at the
   * same moment may both write one; the latest record is a denial either way.
   */
  const recordProviderDenial = async (player: string, topic: string, at: number): Promise<void> => {
    const latest = latestNotificationConsent(
      await store.listConsent(player),
      'host-agreement',
      topic,
    );
    if (latest?.state === 'denied') {
      return;
    }
    await store.appendConsent({
      player,
      record: { kind: 'host-agreement', topic, state: 'denied', source: 'provider' },
      at: formatNotificationInstant(at),
    });
  };

  /** The send's answer after its rows ran: the stored outcome, else the best refusal. */
  const settle = async (
    sendKey: string,
    refusals: readonly NotificationDeliveryRefusal[],
  ): Promise<NotificationDeliveryOutcome> => {
    const held = await store.getSend(sendKey);
    const stored = held === undefined ? undefined : notificationSendOutcome(held.send);
    return stored ?? bestNotificationOutcome(refusals) ?? noEndpoint();
  };

  /**
   * Runs rows one after the other. One row's failure does not stop the
   * others: its row stays due, and the failure is reported. A caller error
   * is thrown once every row ran, and so is the first failure when no row
   * got anywhere, so a caller never mistakes a send that did nothing for an
   * ambiguous one.
   */
  const runInline = async (
    sendKey: string,
    rows: readonly NotificationSendRow[],
    mode: RunMode,
  ): Promise<{ readonly refusals: NotificationDeliveryRefusal[]; readonly failed: number }> => {
    const refusals: NotificationDeliveryRefusal[] = [];
    let callerError: unknown;
    const errors: { readonly error: unknown; readonly row: NotificationSendRow }[] = [];
    for (const row of rows) {
      try {
        const { refusal } = await runRow(sendKey, row.provider, row.key, mode);
        if (refusal !== undefined) {
          refusals.push(refusal);
        }
      } catch (error) {
        if (error instanceof NotificationError && error.code === 'NOTIFICATIONS_INVALID_INPUT') {
          callerError ??= error;
        } else {
          errors.push({ error, row });
        }
      }
    }
    const failed = errors.length + (callerError === undefined ? 0 : 1);
    // When every row failed before its provider call, the first failure is
    // the call's and the rest are reported. A row whose answer could not be
    // stored may have been delivered, so the call answers from the ledger.
    const nothingSent = errors.every(({ error }) => !(error instanceof NotificationSettleError));
    const thrown = callerError
      ?? (failed === rows.length && nothingSent ? errors[0]?.error : undefined);
    for (const { error, row } of errors) {
      if (error !== thrown) {
        report(error, 'dispatch', { sendKey, provider: row.provider, rowKey: row.key });
      }
    }
    if (thrown !== undefined) {
      throw thrown;
    }
    return { refusals, failed };
  };

  /** Evaluates a send this call created, holding its first-evaluation claim. */
  const sendNew = async (
    send: NotificationStoredSend,
    version: string,
    at: number,
  ): Promise<NotificationDeliveryOutcome> => {
    let planned: Awaited<ReturnType<typeof plan>>;
    try {
      planned = await plan(send.request, send.origin, at);
    } catch (error) {
      // Nothing was sent: the key is released so a retry evaluates again.
      try {
        await store.updateSend({ key: send.key, version, send: undefined });
      } catch (releaseError) {
        report(releaseError, 'ledger.release', send.key);
      }
      if (error instanceof NotificationSendInputError) {
        throw invalidInput(error.message, error);
      }
      throw error;
    }
    const { rows, refusals } = planned;
    if (rows.length === 0) {
      await store.updateSend({ key: send.key, version, send: undefined });
      return bestNotificationOutcome(refusals) ?? noEndpoint();
    }
    const { claim: _claim, ...unclaimed } = send;
    const stored: NotificationStoredSend = {
      ...unclaimed,
      rows,
      changedAt: formatNotificationInstant(at),
    };
    if (!await store.updateSend({ key: send.key, version, send: stored })) {
      // The first-evaluation lease ran out and another caller took the key.
      return { status: 'in-flight' };
    }
    const queued = rows.filter((row) => row.state.status === 'in-flight');
    if (queued.length > 0 && input.queue !== undefined) {
      try {
        await input.queue.enqueue(
          queued.map((row) => ({ sendKey: send.key, provider: row.provider, rowKey: row.key })),
        );
      } catch (error) {
        // The rows are stored with a lease: `dispatchDue` runs them once it ends.
        report(error, 'queue.enqueue', send.key);
      }
      return notificationSendOutcome(stored) ?? { status: 'in-flight' };
    }
    const ran = await runInline(send.key, queued, 'job');
    return settle(send.key, [...refusals, ...ran.refusals]);
  };

  // Due rows (the scheduler's dispatch).

  /**
   * Takes due rows for the queue: each becomes a queued row (in flight, no
   * holder) for one claim lease, so the next run does not take it again
   * while its job waits, and a lost job is due again when the lease ends.
   * An attempted row stays attempted (its provider call may have happened),
   * and the take never closes its replay window early. Answers the rows it
   * took; a row that is no longer due is left.
   */
  const takeRows = async (
    sendKey: string,
    wanted: readonly NotificationSendRow[],
  ): Promise<NotificationSendRow[]> => {
    const names = new Set(wanted.map((row) => JSON.stringify([row.key, row.provider])));
    for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
      const held = await store.getSend(sendKey);
      if (held === undefined) {
        return [];
      }
      const at = nowMs();
      const taken: NotificationSendRow[] = [];
      const rows = held.send.rows.map((row) => {
        if (!names.has(JSON.stringify([row.key, row.provider])) || !isNotificationRowDue(row, at)) {
          return row;
        }
        const next = takenRow(row, at, leaseMs);
        taken.push(next);
        return next;
      });
      if (taken.length === 0) {
        return [];
      }
      if (
        await store.updateSend({
          key: sendKey,
          version: held.version,
          send: { ...held.send, scheduled: true, rows, changedAt: formatNotificationInstant(at) },
        })
      ) {
        return taken;
      }
    }
    throw busy(sendKey);
  };

  /**
   * The remaining dispatches each provider allows this run: its registry
   * `rate` less the deliveries in the rate window (`t − window < s ≤ t`),
   * read once per run, less every row this run took since. Sends still in
   * flight from earlier runs are not counted, so they may pass it by a few.
   */
  const paceBudgets = () => {
    const budgets = new Map<string, number>();
    return {
      async take(provider: string): Promise<boolean> {
        let left = budgets.get(provider);
        if (left === undefined) {
          const rate = registry.provider(provider)?.entry.rate;
          left = rate === undefined
            ? Number.POSITIVE_INFINITY
            : rate.count - await store.countHistory({
              provider,
              since: formatNotificationInstant(nowMs() - rate.windowSeconds * secondMs + 1),
            });
        }
        budgets.set(provider, left - 1);
        return left > 0;
      },
    };
  };

  /**
   * One batch of due rows. `pace` carries each provider's remaining budget
   * across the batches of one scheduler run, so rows taken in an earlier
   * batch (still in flight, not yet counted as delivered) count too.
   * Answers how many sends were listed and how many of them the pace held
   * back entirely.
   */
  const dispatchDueRows = async (
    options: { readonly limit?: number } = {},
    pace: ReturnType<typeof paceBudgets> = paceBudgets(),
  ) => {
    const limit = batchLimit(options.limit);
    const keys = await store.listDueSends({ at: formatNotificationInstant(nowMs()), limit });
    const listed = keys.length;
    const results: NotificationDueResult[] = [];
    let failed = 0;
    let paced = 0;
    for (const sendKey of keys) {
      try {
        const held = await store.getSend(sendKey);
        if (held === undefined) {
          continue;
        }
        const at = nowMs();
        // Oldest first within each provider's pace: a row over it stays due for the next run.
        const due: NotificationSendRow[] = [];
        let heldBack = false;
        for (const row of held.send.rows) {
          if (isNotificationRowDue(row, at)) {
            if (await pace.take(row.provider)) {
              due.push(row);
            } else {
              heldBack = true;
            }
          }
        }
        if (due.length === 0) {
          paced += heldBack ? 1 : 0;
          continue;
        }
        if (input.queue !== undefined) {
          const taken = await takeRows(sendKey, due);
          if (taken.length === 0) {
            continue;
          }
          try {
            await input.queue.enqueue(
              taken.map((row) => ({ sendKey, provider: row.provider, rowKey: row.key })),
            );
          } catch (error) {
            // The rows are taken for one lease: the next run takes them again after it.
            failed += 1;
            report(error, 'queue.enqueue', sendKey);
          }
          results.push({ sendKey, outcome: await settle(sendKey, []) });
          continue;
        }
        const ran = await runInline(sendKey, due, 'due');
        if (ran.failed > 0) {
          failed += 1;
        }
        results.push({ sendKey, outcome: await settle(sendKey, ran.refusals) });
      } catch (error) {
        failed += 1;
        report(error, 'dispatchDue', sendKey);
      }
    }
    return { results, failed, listed, paced };
  };

  // Scheduler items.

  /**
   * The send a scheduler item makes, keyed by the item: a new key held by a
   * first-evaluation claim before any row (`created`), the stored send when
   * one with rows exists (`existing`), or `busy` while another run holds the
   * key without rows yet. A key whose holder stopped before storing a row
   * starts over once its lease ends.
   */
  const createItemSend = async (
    request: NotificationStoredSendRequest,
    origin: NotificationSendOrigin,
    at: number,
  ): Promise<
    | { readonly created: { readonly send: NotificationStoredSend; readonly version: string } }
    | { readonly existing: NotificationStoredSend }
    | 'busy'
  > => {
    for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
      const held = await store.getSend(request.idempotencyKey);
      if (held !== undefined) {
        const { send } = held;
        if (send.rows.length > 0) {
          return { existing: send };
        }
        if (send.claim !== undefined && Date.parse(send.claim.leaseUntil) > at) {
          return 'busy';
        }
        await store.updateSend({ key: send.key, version: held.version, send: undefined });
        continue;
      }
      const send: NotificationStoredSend = {
        key: request.idempotencyKey,
        fingerprint: notificationSendFingerprint(request),
        request,
        origin,
        scheduled: true,
        rows: [],
        claim: { token: newToken(), leaseUntil: formatNotificationInstant(at + leaseMs) },
        changedAt: formatNotificationInstant(at),
      };
      const version = await store.createSend(send);
      if (version !== undefined) {
        return { created: { send, version } };
      }
    }
    throw busy(request.idempotencyKey);
  };

  const releaseQuietly = async (key: string, version: string): Promise<void> => {
    try {
      await store.updateSend({ key, version, send: undefined });
    } catch (error) {
      report(error, 'ledger.release', key);
    }
  };

  /**
   * Plans the rows of a send `createItemSend` made and stores them, due at
   * `dueAt`. Answers the send's result and whether rows were stored (a gate
   * refusal stores none and releases the key); `undefined` when a cancel
   * removed the key meanwhile, so nothing was stored. A caller error
   * releases the key and throws `NOTIFICATIONS_INVALID_INPUT`; any other
   * failure releases it and rethrows.
   */
  const storeItemRows = async (
    created: { readonly send: NotificationStoredSend; readonly version: string },
    at: number,
    dueAt: number,
  ): Promise<{ readonly outcome: NotificationDeliveryOutcome; readonly stored: boolean } | undefined> => {
    const { send, version } = created;
    let planned: Awaited<ReturnType<typeof plan>>;
    try {
      planned = await plan(send.request, send.origin, at, Math.min(dueAt, at));
    } catch (error) {
      await releaseQuietly(send.key, version);
      if (error instanceof NotificationSendInputError) {
        throw invalidInput(error.message, error);
      }
      throw error;
    }
    if (planned.rows.length === 0) {
      await releaseQuietly(send.key, version);
      return { outcome: bestNotificationOutcome(planned.refusals) ?? noEndpoint(), stored: false };
    }
    const { claim: _claim, ...unclaimed } = send;
    const stored: NotificationStoredSend = {
      ...unclaimed,
      rows: planned.rows,
      changedAt: formatNotificationInstant(at),
    };
    // A cancel since the key was made removed it: nothing is stored or sent.
    if (!await store.updateSend({ key: send.key, version, send: stored })) {
      return undefined;
    }
    return { outcome: notificationSendOutcome(stored) ?? { status: 'in-flight' }, stored: true };
  };

  /** The content of a reminder's send: kept on a fired reminder, which drops the rest. */
  const reminderFingerprint = (player: string, reminder: NotificationStoredReminder): string =>
    reminder.fingerprint ?? notificationSendFingerprint(reminderRequest(player, reminder));

  /** The send a reminder makes: its request, whose fingerprint names its content. */
  const reminderRequest = (
    player: string,
    reminder: NotificationStoredReminder,
  ): NotificationStoredSendRequest => ({
    idempotencyKey: createNotificationReminderIdempotencyKey({
      player,
      key: reminder.key,
      fireAt: reminder.fireAt,
    }),
    player,
    topic: reminder.topic,
    ...(reminder.templateData === undefined ? {} : { templateData: reminder.templateData }),
    ...(reminder.link === undefined ? {} : { link: reminder.link }),
  });

  /**
   * Stops a reminder's send that still waits: the rows not delivered yet
   * (deferred, queued, or in flight) are dropped, and a send the scheduler
   * is still making loses its key, so no row of it is ever stored. Only a
   * send of `fingerprint` (the reminder's own content) is stopped, since the
   * send key names only the key and time: a send of other content at the key
   * belongs to the reminder that replaced this one. A send the provider may
   * already have accepted cannot be recalled. Answers whether anything waited.
   */
  const stopReminderSend = async (
    player: string,
    reminder: NotificationStoredReminder,
    fingerprint: string,
  ): Promise<boolean> => {
    let key: string;
    try {
      key = createNotificationReminderIdempotencyKey({ player, key: reminder.key, fireAt: reminder.fireAt });
    } catch {
      return false;
    }
    for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
      const held = await store.getSend(key);
      if (held === undefined || held.send.origin.kind !== 'reminder' || held.send.fingerprint !== fingerprint) {
        return false;
      }
      const { send } = held;
      const kept = send.rows.filter((row) => row.state.status === 'delivered');
      if (send.rows.length > 0 && kept.length === send.rows.length) {
        return false;
      }
      const next = kept.length === 0
        ? undefined
        : { ...send, rows: kept, changedAt: formatNotificationInstant(nowMs()) };
      if (await store.updateSend({ key, version: held.version, send: next })) {
        return true;
      }
    }
    throw busy(key);
  };

  /** Moves an entry's due time later after a failure, so a broken item does not fill every run. */
  const deferEntry = async (held: NotificationVersionedScheduleEntry, at: number): Promise<void> => {
    try {
      await store.updateScheduleEntry({
        player: held.entry.player,
        id: held.entry.id,
        version: held.version,
        entry: { ...held.entry, dueAt: formatNotificationInstant(at + schedulerRetryMs) },
      });
    } catch (error) {
      report(error, 'scheduler.defer');
    }
  };

  const removeEntry = (held: NotificationVersionedScheduleEntry): Promise<boolean> =>
    store.updateScheduleEntry({
      player: held.entry.player,
      id: held.entry.id,
      version: held.version,
      entry: undefined,
    });

  /**
   * A due reminder becomes its `reminder:<player>:<key>:<fireAt>` send to
   * every provider the player has a recipient on, through the gate. The
   * rows are stored first and the reminder is marked fired after (kept until
   * its key's retention ends, so a later set or cancel can still stop the
   * send), so a run that stops between them leaves the reminder pending and
   * the next run finds its rows. A refused send spends the reminder. A set or
   * cancel since the read wins: it stops the send, and so does this run.
   */
  const fireReminder = async (
    held: NotificationVersionedScheduleEntry,
    reminder: NotificationStoredReminder,
  ): Promise<NotificationDueResult | undefined> => {
    const { player } = held.entry;
    const at = nowMs();
    let key: string;
    try {
      key = createNotificationReminderIdempotencyKey({ player, key: reminder.key, fireAt: reminder.fireAt });
    } catch (error) {
      // A reminder whose send cannot be keyed fails once.
      await removeEntry(held);
      throw invalidInput(describe(error), error);
    }
    const request = reminderRequest(player, reminder);
    const fingerprint = notificationSendFingerprint(request);
    // A fired reminder keeps only what names its send, and the fingerprint
    // of its own content (the canonical request, which the send also keeps).
    const fired: NotificationScheduleEntry = {
      player,
      id: held.entry.id,
      dueAt: formatNotificationInstant(at + keyRetentionMs),
      item: {
        kind: 'reminder',
        key: reminder.key,
        topic: reminder.topic,
        fireAt: reminder.fireAt,
        firedAt: formatNotificationInstant(at),
        fingerprint,
      },
    };
    const markFired = () =>
      store.updateScheduleEntry({ player, id: held.entry.id, version: held.version, entry: fired });
    let made = await createItemSend(request, { kind: 'reminder', key: reminder.key }, at);
    if (made !== 'busy' && 'existing' in made && made.existing.fingerprint !== fingerprint) {
      // The key holds a send of other content. If this reminder is still
      // the current one (as of the re-read), that send is of a reminder it
      // replaced at the same time: what still waits of it goes, and this
      // reminder makes its own. If not, this run read a reminder a set has
      // replaced since, and the send is the newer reminder's: it is left
      // alone. A set that lands between the re-read and the stop stops this
      // reminder's own send and the next run repairs the rest.
      const current = await store.getScheduleEntry({ player, id: held.entry.id });
      if (current?.version !== held.version) {
        return undefined;
      }
      await stopReminderSend(player, reminder, made.existing.fingerprint);
      made = await createItemSend(request, { kind: 'reminder', key: reminder.key }, at);
      if (made !== 'busy' && 'existing' in made && made.existing.fingerprint !== fingerprint) {
        // A row of it was delivered, so the key keeps that send: this
        // reminder cannot have its own under the same key and time.
        report(
          new Error(
            "A delivered send of another reminder holds this reminder's key and time; it is not sent.",
          ),
          'scheduler.reminder',
          key,
        );
        await markFired();
        return undefined;
      }
    }
    if (made === 'busy') {
      // Another run is making the send; its lease frees the key if it stops.
      return undefined;
    }
    if ('existing' in made) {
      // Its rows were stored by a run that stopped before marking it: they carry it.
      await markFired();
      return undefined;
    }
    let result: Awaited<ReturnType<typeof storeItemRows>>;
    try {
      // The rows are due when the entry was: a past fireAt counts from its
      // set time. A pending reminder always has a due time (runScheduler
      // takes only entries with one); fireAt only satisfies the type.
      result = await storeItemRows(made.created, at, Date.parse(held.entry.dueAt ?? reminder.fireAt));
    } catch (error) {
      if (error instanceof NotificationError && error.code === 'NOTIFICATIONS_INVALID_INPUT') {
        // A send that cannot be made as asked fails once.
        await removeEntry(held);
      }
      throw error;
    }
    if (result === undefined) {
      return undefined;
    }
    if (!result.stored) {
      // Refused by the gate: the reminder is spent, as a send would be.
      await removeEntry(held);
      return { sendKey: key, outcome: result.outcome };
    }
    if (!await markFired()) {
      // The entry changed since the read. The rows serve it when it is the
      // same reminder (time and content), pending or marked fired by another
      // run that found them. A cancel, or a set to another time or content,
      // stops them: theirs runs before their write, and this one covers a
      // send stored after it. Only this content's send is stopped, so a send
      // the new reminder made at the same key stays. A read that fails stops
      // them too, so a cancel is never outlived by its send.
      let same = false;
      try {
        const now = (await store.getScheduleEntry({ player, id: held.entry.id }))?.entry.item;
        same = now?.kind === 'reminder'
          && now.fireAt === reminder.fireAt
          && reminderFingerprint(player, now) === fingerprint;
      } catch (error) {
        report(error, 'scheduler.reread');
      }
      if (!same) {
        await stopReminderSend(player, reminder, fingerprint);
      }
      return undefined;
    }
    return { sendKey: key, outcome: result.outcome };
  };

  /**
   * A fired reminder whose send key's retention ended is forgotten, unless
   * its send still waits (a long rate-limit or ambiguous replay keeps the
   * key alive): then it looks again a day later.
   */
  const forgetFiredReminder = async (
    held: NotificationVersionedScheduleEntry,
    reminder: NotificationStoredReminder,
  ): Promise<void> => {
    let key: string | undefined;
    try {
      key = createNotificationReminderIdempotencyKey({
        player: held.entry.player,
        key: reminder.key,
        fireAt: reminder.fireAt,
      });
    } catch {
      key = undefined;
    }
    // A read that fails throws, so the entry waits a minute rather than going while its send may wait.
    const waiting = key !== undefined
      && ((await store.getSend(key))?.send.rows.some((row) => row.state.status !== 'delivered') ?? false);
    if (!waiting) {
      await removeEntry(held);
      return;
    }
    await store.updateScheduleEntry({
      player: held.entry.player,
      id: held.entry.id,
      version: held.version,
      entry: { ...held.entry, dueAt: formatNotificationInstant(nowMs() + dayMs) },
    });
  };

  /** The instant an Asia/Seoul calendar date starts. */
  const seoulMidnight = (date: string): number => Date.parse(`${date}T00:00:00+09:00`);
  const noticeIdentity = (notice: NotificationNotice): NotificationNoticeIdentity => ({
    kind: notice.kind,
    record: { kind: notice.record.kind, at: normalizeNotificationTimestamp(notice.record.at) },
    dueBy: notice.dueBy,
  });
  const carriesNotices = (): boolean =>
    rules === 'kr'
    && noticeTopic !== undefined
    && registry.providers.some((provider) => notificationProviderCarriesNotices(provider.entry));

  /**
   * The player's notice check: each listed notice nobody recorded by the
   * start of the Asia/Seoul day seven days before its `dueBy` becomes its
   * `notice:` send through the notice topic, in the variant it is listed
   * with, filled with `consentDate`. Then the check is due again at the
   * earliest of: the next notice's first send day (a later result notice or
   * re-confirmation), an hour while a push waits in the ledger, and the
   * backoff after a refused push (an hour, doubling to a day). With nothing
   * owed it is removed.
   */
  const checkNotices = async (
    held: NotificationVersionedScheduleEntry,
    check: NotificationNoticeCheck,
  ): Promise<NotificationDueResult[]> => {
    const { player } = held.entry;
    if (!carriesNotices() || noticeTopic === undefined) {
      await removeEntry(held);
      return [];
    }
    const at = nowMs();
    const now = formatNotificationInstant(at);
    const today = toSeoulCalendarDate(now);
    try {
      // Only the player can make a notice key fail (an id with a lone surrogate): its check fails once.
      createNotificationNoticeIdempotencyKey({
        kind: 'consent-result',
        record: { kind: 'advertising', at: now },
        dueBy: today,
        player,
      });
    } catch (error) {
      await removeEntry(held);
      report(error, 'scheduler.notice');
      return [];
    }
    const records = await store.listConsent(player);
    const given = await store.listNoticesGiven(player);
    const owed = listNotificationNotices(records, given, now);
    const failed = new Set(check.failed ?? []);
    const previouslyPushed = new Set(check.pushed ?? []);
    const pushed: string[] = [];
    const results: NotificationDueResult[] = [];
    let waiting = false;
    let refused = false;
    for (const notice of owed) {
      const sendFrom = notificationNoticeSendFrom(notice.dueBy);
      const identity = noticeIdentity(notice);
      const key = createNotificationNoticeIdempotencyKey({ ...identity, player });
      if (sendFrom > today || failed.has(key)) {
        continue;
      }
      const existing = await store.getSend(key);
      if (existing === undefined && previouslyPushed.has(key)) {
        // The last check pushed it, and the push is gone while the notice is
        // still owed: the provider refused it when it was sent. It waits out
        // the backoff like a push the gate refused.
        refused = true;
        continue;
      }
      const request: NotificationStoredSendRequest = {
        idempotencyKey: key,
        player,
        topic: noticeTopic,
        templateData: { consentDate: toSeoulCalendarDate(identity.record.at) },
      };
      const made = await createItemSend(
        request,
        { kind: 'notice', notice: identity, variant: notice.variant },
        at,
      );
      if (made === 'busy') {
        // Any waiting push stays this check's push, so a refusal after it backs off.
        waiting = true;
        pushed.push(key);
        continue;
      }
      if ('existing' in made) {
        if (notificationSendOutcome(made.existing)?.status === 'delivered') {
          // Delivered, but its record was not written: it is recorded now (while it is listed), not pushed again.
          if (await noticeListed(player, identity, at)) {
            await store.addNoticeGiven({ ...identity, player, channel: 'push', at: now });
          }
        } else {
          // Still waiting: it stays this check's push, so a later refusal still backs off.
          waiting = true;
          pushed.push(key);
        }
        continue;
      }
      try {
        const result = await storeItemRows(made.created, at, seoulMidnight(sendFrom));
        if (result === undefined) {
          // Another run took the key over: its push is looked at again.
          waiting = true;
        } else {
          results.push({ sendKey: key, outcome: result.outcome });
          if (result.stored) {
            waiting = true;
            pushed.push(key);
          } else {
            refused = true;
          }
        }
      } catch (error) {
        if (!(error instanceof NotificationError && error.code === 'NOTIFICATIONS_INVALID_INPUT')) {
          throw error;
        }
        // A push that cannot render fails once; the game still owes the notice.
        failed.add(key);
        report(error, 'scheduler.notice', key);
      }
    }
    // Every notice still owed, now or later (the next re-confirmation of each consent).
    const ahead = listNotificationNotices(records, given, noticeHorizon);
    const owedKeys = new Set(
      ahead.map((notice) =>
        createNotificationNoticeIdempotencyKey({ ...noticeIdentity(notice), player }),
      ),
    );
    const stillFailed = [...failed].filter((key) => owedKeys.has(key));
    let next: number | undefined;
    const consider = (time: number): void => {
      next = next === undefined ? time : Math.min(next, time);
    };
    for (const notice of ahead) {
      const sendFrom = notificationNoticeSendFrom(notice.dueBy);
      if (sendFrom > today) {
        consider(seoulMidnight(sendFrom));
      }
    }
    if (waiting) {
      consider(at + noticeRecheckMs);
    }
    // Refusals in a row: a push that is only waiting proves nothing yet, and
    // nothing left to push ends the series.
    let attempts = 0;
    if (refused) {
      attempts = check.attempts + 1;
    } else if (waiting) {
      attempts = check.attempts;
    }
    if (refused) {
      consider(at + Math.min(noticeBackoffMs * 2 ** Math.min(attempts - 1, 16), dayMs));
    }
    const item: NotificationNoticeCheck = {
      kind: 'notices',
      attempts,
      ...(stillFailed.length === 0 ? {} : { failed: stillFailed }),
      ...(pushed.length === 0 ? {} : { pushed }),
    };
    // With nothing to look at again, a check that remembers failed pushes
    // stays without a due time, so they still fail once; a new record makes
    // it due again.
    let settled: NotificationScheduleEntry | undefined;
    if (next !== undefined) {
      settled = { player, id: noticesEntryId, dueAt: formatNotificationInstant(next), item };
    } else if (stillFailed.length > 0) {
      settled = { player, id: noticesEntryId, item };
    }
    // A record written since the check began made it due again: that stands.
    await store.updateScheduleEntry({
      player,
      id: noticesEntryId,
      version: held.version,
      entry: settled,
    });
    return results;
  };

  /**
   * Makes the player's notice check due at `at`, and clears its backoff. With
   * `onlyBackedOff`, it acts only on a check that is backing off after a
   * refused push (a new registration may let the push through).
   */
  const markNoticesDue = async (player: string, at: number, onlyBackedOff = false): Promise<void> => {
    if (!carriesNotices()) {
      return;
    }
    for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
      const held = await store.getScheduleEntry({ player, id: noticesEntryId });
      const check: NotificationNoticeCheck = held?.entry.item.kind === 'notices'
        ? held.entry.item
        : { kind: 'notices', attempts: 0 };
      if (onlyBackedOff && (held === undefined || check.attempts === 0)) {
        return;
      }
      const dueAt = held?.entry.dueAt === undefined
        ? at
        : Math.min(Date.parse(held.entry.dueAt), at);
      if (held !== undefined && check.attempts === 0 && held.entry.dueAt !== undefined && Date.parse(held.entry.dueAt) <= at) {
        return;
      }
      // A new act or registration starts over: the backoff ends, and the
      // pushes of the last check are not read as refused.
      const { pushed: _pushed, ...kept } = check;
      const entry: NotificationScheduleEntry = {
        player,
        id: noticesEntryId,
        dueAt: formatNotificationInstant(dueAt),
        item: { ...kept, attempts: 0 },
      };
      if (
        held === undefined
          ? (await store.createScheduleEntry(entry)) !== undefined
          : await store.updateScheduleEntry({ player, id: noticesEntryId, version: held.version, entry })
      ) {
        return;
      }
    }
    throw busy(noticesEntryId);
  };

  /**
   * Deletes the records no rule reads any more, once they are a day old (the
   * daily cap still counts younger ones): every record but the latest of its
   * kind and scope, except, under the Korean rules, an advertising or night
   * record whose result notice is still owed and the record of its kind
   * before it, which decides whether it reports a refusal. The latest
   * consent of a kind is the latest record of it, so re-confirmations keep
   * their record. A failure is reported; the history only stays longer.
   */
  const compactConsent = async (
    player: string,
    records: readonly NotificationConsentRecord[],
    at: number,
  ): Promise<void> => {
    try {
      const keep = new Set<number>();
      const latest = new Map<string, NotificationConsentRecord>();
      for (const record of records) {
        latest.set(JSON.stringify([record.kind, record.topic ?? null]), record);
      }
      for (const record of latest.values()) {
        keep.add(Date.parse(record.at));
      }
      if (rules === 'kr' && records.some((record) => record.kind === 'advertising' || record.kind === 'night')) {
        const owed = new Set(
          listNotificationNotices(records, await store.listNoticesGiven(player), formatNotificationInstant(at))
            .map((notice) => Date.parse(notice.record.at)),
        );
        for (const kind of ['advertising', 'night'] as const) {
          const series = records.filter((record) => record.kind === kind);
          series.forEach((record, index) => {
            if (owed.has(Date.parse(record.at))) {
              keep.add(Date.parse(record.at));
              const before = series[index - 1];
              if (before !== undefined) {
                keep.add(Date.parse(before.at));
              }
            }
          });
        }
      }
      // A per-send provider counts every accepted prompt (gate step 3), so
      // while one is registered the acceptance records are never pruned, and
      // that part of the history grows with every acceptance.
      // The registry refuses per-send providers today; this keeps a
      // registry that serves one from losing acceptances silently.
      const perSend = registry.providers.some(
        (provider) => provider.entry.permission.allowance === 'per-send',
      );
      const prunable = records.filter((record) =>
        Date.parse(record.at) <= at - consentCompactionMs
        && !keep.has(Date.parse(record.at))
        && !(perSend && (record.kind === 'delivery-permission' || record.kind === 'host-agreement')));
      if (prunable.length > 0) {
        await store.pruneConsent({ player, at: prunable.map((record) => record.at) });
      }
    } catch (error) {
      report(error, 'consent.compact');
    }
  };

  /**
   * Makes the player's notice check due now, best effort: after a
   * registration only a check backing off after a refused push (the new
   * device may let it through), after a consent write any.
   */
  const retryNoticePushes = async (
    player: string,
    onlyBackedOff = true,
    phase: 'registration' | 'before-consent' | 'after-consent' = 'registration',
  ): Promise<void> => {
    try {
      await markNoticesDue(player, nowMs(), onlyBackedOff);
    } catch (error) {
      report(error, phase === 'registration' ? 'notices.retry' : `notices.retry.${phase}`);
    }
  };

  /**
   * One round's schedule entries: up to `limit` due ones, each fired,
   * checked, or forgotten, with each send it touched. A schedule that cannot
   * be read is counted and reported, and the round's due rows still go out.
   */
  const runScheduleEntries = async (
    limit: number,
    touched: Map<string, NotificationDeliveryOutcome>,
  ): Promise<{
    readonly listed: number;
    readonly handled: number;
    readonly failed: number;
  }> => {
    let failed = 0;
    let due: readonly { readonly player: string; readonly id: string }[] = [];
    try {
      due = await store.listDueScheduleEntries({ at: formatNotificationInstant(nowMs()), limit });
    } catch (error) {
      // The due rows still go out: a schedule that cannot be read must not hold them.
      failed += 1;
      report(error, 'scheduler.list');
    }
    let handled = 0;
    for (const { player, id } of due) {
      let held: NotificationVersionedScheduleEntry | undefined;
      try {
        held = await store.getScheduleEntry({ player, id });
        if (held?.entry.dueAt === undefined || Date.parse(held.entry.dueAt) > nowMs()) {
          continue;
        }
        const { item } = held.entry;
        if (item.kind === 'notices') {
          for (const result of await checkNotices(held, item)) {
            touched.set(result.sendKey, result.outcome);
          }
        } else if (item.firedAt !== undefined) {
          await forgetFiredReminder(held, item);
        } else {
          const result = await fireReminder(held, item);
          if (result !== undefined) {
            touched.set(result.sendKey, result.outcome);
          }
        }
        // Counted once the entry was worked: a failing one is not progress.
        handled += 1;
      } catch (error) {
        failed += 1;
        report(error, 'scheduler', `${encodeURIComponent(player)}:${id}`);
        // A failure that may pass waits a minute; one that already moved or
        // removed the entry (its version changed) is left as it is.
        if (held !== undefined && !(error instanceof NotificationError && error.code === 'NOTIFICATIONS_INVALID_INPUT')) {
          await deferEntry(held, nowMs());
        }
      }
    }
    return { listed: due.length, handled, failed };
  };

  /**
   * Each authenticated call carries the session's current end, and the
   * endpoints the session registered move to it when it is later, so a
   * session the identity service extended keeps its devices bound without a
   * new registration. It never fails the call; a failure is reported. It
   * runs before a call's own validation on purpose: the session is
   * authenticated, so even a call refused for its input reports a valid end.
   */
  const authenticated = async (session: NotificationSession): Promise<NotificationSession> => {
    const current = sessionOf(session);
    try {
      await store.extendSessionEndpoints({
        sessionId: current.sessionId,
        ...(current.expiresAt === undefined ? {} : { expiresAt: normalizeNotificationTimestamp(current.expiresAt) }),
      });
    } catch (error) {
      report(error, 'endpoints.extend');
    }
    return current;
  };

  return {
    providers: () => registry.snapshot(),

    async recordConsent(session, record) {
      const { player } = await authenticated(session);
      if (!isPlainObject(record)) {
        throw invalidInput('A consent record is an object.');
      }
      const at = formatNotificationInstant(nowMs());
      // The backend's clock dates the record; a client's `at` is ignored.
      const { at: _clientAt, ...fields } = record;
      let checked: NotificationConsentRecord;
      try {
        checked = assertNotificationConsentRecord({ ...fields, at });
      } catch (error) {
        throw invalidInput(`Invalid consent record: ${describe(error)}`, error);
      }
      if (checked.source === 'provider') {
        throw invalidInput('Provider records are written only by the backend from a provider answer.');
      }
      if (
        (checked.topic !== undefined && notificationKeyIssue(checked.topic) !== undefined)
        || (checked.textVersion !== undefined && !isBoundedText(checked.textVersion))
        || (checked.evidence !== undefined && new TextEncoder().encode(JSON.stringify(checked.evidence)).length > maxEvidenceBytes)
      ) {
        throw invalidInput('A consent record field is out of bounds.');
      }
      const history = await store.listConsent(player);
      // A repeat of the latest permission, agreement, or preference record
      // for the kind and topic is not written again: a client that resends
      // its report changes nothing. Evidence is not compared, so the first
      // record keeps its own. An `advertising` or `night` record is always
      // written, since each is a player's act that may owe a notice (a
      // second refusal, a renewed consent).
      const latest = checked.kind === 'advertising' || checked.kind === 'night'
        ? undefined
        : latestNotificationConsent(history, checked.kind, checked.topic);
      if (latest !== undefined && latest.state === checked.state && latest.source === checked.source) {
        return latest;
      }
      const windowStart = Date.parse(at) - dayMs;
      const counted = history.filter((entry) => entry.source !== 'provider' && Date.parse(entry.at) > windowStart);
      const oldest = counted[counted.length - maxClientNotificationConsentRecordsPerDay];
      if (oldest !== undefined) {
        throw new NotificationConsentRateLimitError(
          Math.max(1, Math.ceil((Date.parse(oldest.at) - windowStart) / secondMs)),
        );
      }
      const { at: _at, ...withoutAt } = checked;
      if (checked.kind === 'advertising' || checked.kind === 'night') {
        // Before the write, and again after it: a check that finds nothing new
        // is harmless. Best effort, so the player's consent is recorded even
        // while the schedule cannot be written; the game still lists the
        // notice in game.
        await retryNoticePushes(player, false, 'before-consent');
      }
      const stored = await store.appendConsent({ player, record: withoutAt as NotificationConsentRecordInput, at });
      if (stored.kind === 'advertising' || stored.kind === 'night') {
        // Again after the write: a check that ran between the two found nothing new and settled.
        await retryNoticePushes(player, false, 'after-consent');
      }
      await compactConsent(player, [...history, stored], Date.parse(at));
      return stored;
    },

    async listConsent(session) {
      return store.listConsent((await authenticated(session)).player);
    },

    async registerEndpoint(session, request) {
      const current = await authenticated(session);
      let registration: ReturnType<typeof assertNotificationEndpointRegistration>;
      try {
        registration = assertNotificationEndpointRegistration(request.registration);
      } catch (error) {
        throw invalidInput(`Invalid registration: ${describe(error)}`, error);
      }
      const provider = registry.provider(registration.provider);
      if (provider === undefined) {
        throw invalidInput(`This backend has no notifications provider ${registration.provider}.`);
      }
      if (
        (registration.locale !== undefined && !isBoundedText(registration.locale, 64))
        || (registration.timeZone !== undefined && !isValidNotificationTimeZone(registration.timeZone))
      ) {
        throw invalidInput('The registration locale or time zone is not valid.');
      }
      const registeredAt = formatNotificationInstant(nowMs());
      const { address } = registration;
      if (address.kind === 'platform-user') {
        if (provider.entry.addressing !== 'platform-user') {
          throw invalidInput(`Provider ${provider.entry.provider} sends to devices; it needs a device address.`);
        }
        await store.putPlatformRegistration({
          player: current.player,
          provider: provider.entry.provider,
          ...(registration.locale === undefined ? {} : { locale: registration.locale }),
          ...(registration.timeZone === undefined ? {} : { timeZone: registration.timeZone }),
          registeredAt,
        });
        await retryNoticePushes(current.player);
        return;
      }
      if (provider.entry.addressing !== 'device') {
        throw invalidInput(`Provider ${provider.entry.provider} resolves platform users; it takes no device address.`);
      }
      if (!provider.addressKinds.includes(address.kind)) {
        // No provider sends to a Firebase installation id yet; the kind is
        // reserved for when FCM does (RFC "Delivery providers").
        const reserved = address.kind === 'fcm-installation' && provider.addressKinds.includes('fcm-token')
          ? ` ${fcmInstallationIdRefusal}`
          : '';
        throw invalidInput(`Provider ${provider.entry.provider} cannot send to ${address.kind} addresses.${reserved}`);
      }
      if (address.value.length > maxAddressLength || hasControlCharacter(address.value)) {
        throw invalidInput('The device address is out of bounds.');
      }
      if (request.target === undefined && provider.targets.length > 1) {
        throw invalidInput(
          `Provider ${provider.entry.provider} serves ${provider.targets.join(', ')}; the registration names its target.`,
        );
      }
      if (request.target !== undefined && !provider.targets.includes(request.target)) {
        throw invalidInput(`Provider ${provider.entry.provider} does not serve target ${String(request.target)}.`);
      }
      await store.putEndpoint({
        provider: provider.entry.provider,
        installationId: current.installationId,
        player: current.player,
        address: {
          kind: address.kind,
          value: address.value,
          ...(address.environment === undefined ? {} : { environment: address.environment }),
        },
        permission: address.permission,
        ...(registration.locale === undefined ? {} : { locale: registration.locale }),
        ...(registration.timeZone === undefined ? {} : { timeZone: registration.timeZone }),
        ...(request.target === undefined ? {} : { target: request.target }),
        sessionId: current.sessionId,
        ...(current.expiresAt === undefined ? {} : { sessionExpiresAt: normalizeNotificationTimestamp(current.expiresAt) }),
        lastRegisteredAt: registeredAt,
      });
      await retryNoticePushes(current.player);
    },

    async unregisterEndpoint(session, request = {}) {
      const current = await authenticated(session);
      if (request.provider !== undefined && !isBoundedText(request.provider)) {
        throw invalidInput('provider: expected a non-empty string.');
      }
      await store.removeEndpoints({
        installationId: current.installationId,
        player: current.player,
        ...(request.provider === undefined ? {} : { provider: request.provider }),
      });
    },

    async endSession({ sessionId }) {
      if (!isBoundedText(sessionId)) {
        throw invalidInput('sessionId: expected a non-empty string.');
      }
      await store.removeSessionEndpoints({ sessionId });
    },

    async listNotices(session) {
      return noticesOf((await authenticated(session)).player, nowMs());
    },

    async recordNoticeShown(session, notice, options = {}) {
      const { player } = await authenticated(session);
      let named: NotificationNoticeIdentity;
      try {
        const parsed = assertRecordNotificationNoticeInput(notice);
        named = {
          kind: parsed.kind,
          record: { kind: parsed.record.kind, at: normalizeNotificationTimestamp(parsed.record.at) },
          dueBy: parsed.dueBy,
        };
      } catch (error) {
        throw invalidInput(
          'A notice is a listed notice, or its kind, the kind and time of the record it reports on, '
            + `and its dueBy: ${describe(error)}`,
          error,
        );
      }
      const channel = options.channel === undefined ? 'in-game' : options.channel;
      // Only the backend records a push, once the push is delivered.
      if (channel !== 'in-game' && channel !== 'other') {
        throw invalidInput('channel: a game records a notice it showed, in-game or other.');
      }
      const at = nowMs();
      // Only a listed notice is recorded: one already recorded, not listed
      // yet, or unknown changes nothing, so a retried call is safe.
      if (!await noticeListed(player, named, at)) {
        return;
      }
      await store.addNoticeGiven({ ...named, player, channel, at: formatNotificationInstant(at) });
    },

    async deliver(raw) {
      const request = sendRequestOf(raw);
      refuseNoticeTopic(request.topic);
      const fingerprint = notificationSendFingerprint(request);
      const key = request.idempotencyKey;
      for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
        const at = nowMs();
        const held = await lookup(key, at);
        if (held !== undefined) {
          if (held.send.fingerprint !== fingerprint) {
            throw new NotificationError('NOTIFICATIONS_IDEMPOTENCY_CONFLICT', {
              message: `Key ${key} is stored for another request.`,
            });
          }
          const { send } = held;
          if (send.rows.length === 0) {
            if (send.claim !== undefined && Date.parse(send.claim.leaseUntil) > at) {
              return { status: 'in-flight' };
            }
            // An evaluation that never finished, or an empty row set: start over.
            await store.updateSend({ key, version: held.version, send: undefined });
            continue;
          }
          const expired = send.rows.filter((row) => eligible('retry', row, at));
          if (expired.length > 0) {
            // A platform row's lease expired: this caller is the next claimer and replays it.
            const wasDelivered = notificationSendOutcome(send)?.status === 'delivered';
            const { refusals } = await runInline(key, expired, 'retry');
            const settled = await settle(key, refusals);
            return wasDelivered && settled.status === 'delivered'
              ? { status: 'delivered', alreadyProcessed: true }
              : settled;
          }
          const stored = notificationSendOutcome(send) ?? noEndpoint();
          return stored.status === 'delivered' ? { status: 'delivered', alreadyProcessed: true } : stored;
        }
        const token = newToken();
        const send: NotificationStoredSend = {
          key,
          fingerprint,
          request,
          origin: { kind: 'send' },
          scheduled: false,
          rows: [],
          claim: { token, leaseUntil: formatNotificationInstant(at + leaseMs) },
          changedAt: formatNotificationInstant(at),
        };
        const version = await store.createSend(send);
        if (version !== undefined) {
          return sendNew(send, version, at);
        }
        // A concurrent send created the key first: answer from its state.
      }
      throw busy(key);
    },

    async dispatch(job) {
      if (
        !isPlainObject(job)
        || !isBoundedText(job.sendKey)
        || !isBoundedText(job.provider)
        || !isBoundedText(job.rowKey, maxRowKeyLength)
      ) {
        throw invalidInput('A dispatch job names its send key, provider, and row key.');
      }
      await runRow(job.sendKey, job.provider, job.rowKey, 'job');
    },

    async dispatchDue(options = {}) {
      const { results, failed } = await dispatchDueRows(options);
      return { results, failed };
    },

    async setReminder(session, raw) {
      const { player } = await authenticated(session);
      const reminder = reminderOf(raw);
      refuseNoticeTopic(reminder.topic);
      if (Date.parse(reminder.fireAt) - nowMs() > notificationReminderHorizonDays * dayMs) {
        throw invalidInput(`Invalid reminder: fireAt is more than ${notificationReminderHorizonDays} days ahead.`);
      }
      let sendKey: string;
      try {
        sendKey = createNotificationReminderIdempotencyKey({ player, key: reminder.key, fireAt: reminder.fireAt });
      } catch (error) {
        throw invalidInput(`Invalid reminder: ${describe(error)}`, error);
      }
      const origin: NotificationSendOrigin = { kind: 'reminder', key: reminder.key };
      // The providers that would deliver the topic remotely, for some target they serve.
      const declaring = registry.providers.filter((provider) =>
        provider.targets.some((target) =>
          catalog.topicsFor(target).some((topic) => topic.id === reminder.topic && topic.channels.includes('remote'))));
      if (declaring.length === 0) {
        throw invalidInput(`Topic ${reminder.topic} is not delivered remotely by this backend.`);
      }
      const advertising = declaring.some((provider) =>
        topicFor(provider, undefined, reminder.topic, origin)?.purpose === 'advertising');
      if (advertising && deployment?.advertisingRules === undefined) {
        // The gate would refuse every send of it, so it is refused now.
        throw invalidInput(`Advertising topic ${reminder.topic} needs the deployment's advertisingRules.`);
      }
      // The same request the scheduler makes, so their fingerprints compare.
      const request = reminderRequest(player, reminder);
      const at = nowMs();
      // Where the player can be reached now, else every declaring provider unresolved.
      const reached = (await recipientsOf(request, at, origin)).filter((recipient) =>
        recipient.resolved && declaring.includes(recipient.provider));
      const candidates: readonly Recipient[] = reached.length > 0
        ? reached
        : declaring.map((provider) => ({ provider, rowKey: sendKey, resolved: false }));
      if (
        reminder.templateData !== undefined
        && candidates.some((recipient) => recipient.provider.entry.content === 'host-template')
      ) {
        throw invalidInput('A host-template provider keeps template context on the server; a reminder takes no templateData.');
      }
      // Gate steps 3 to 5 at set time: one candidate that passes is enough.
      const consent = await store.listConsent(player);
      const permissions = new Map<string, Promise<NotificationPermissionState | undefined>>();
      let refusal: keyof typeof reminderRefusalRank | undefined;
      let passed = false;
      let mapped = false;
      let linkRefusal: string | undefined;
      for (const recipient of candidates) {
        const topic = topicFor(recipient.provider, recipient.target, reminder.topic, origin);
        if (topic === undefined || !topic.channels.includes('remote')) {
          continue;
        }
        mapped = true;
        // The gate's link step, at set time: a provider whose sends need a
        // link takes the reminder's (by its mapping rule) or the mapping's.
        const linkIssue = reminderLinkIssue(recipient.provider, topic, reminder.link);
        if (linkIssue !== undefined) {
          linkRefusal ??= linkIssue;
          continue;
        }
        const id = recipient.provider.entry.provider;
        let permission = permissions.get(id);
        if (permission === undefined) {
          permission = readServerPermission(recipient.provider, request);
          permissions.set(id, permission);
        }
        const serverPermission = await permission;
        const refused = evaluateNotificationReminderConsent({
          entry: recipient.provider.entry,
          topic,
          consent,
          ...(serverPermission === undefined ? {} : { serverPermission }),
          ...(recipient.endpoint === undefined ? {} : { endpointPermission: recipient.endpoint.permission }),
          history: [],
        });
        if (refused === undefined) {
          passed = true;
          break;
        }
        if (refusal === undefined || reminderRefusalRank[refused] > reminderRefusalRank[refusal]) {
          refusal = refused;
        }
      }
      if (!passed) {
        if (refusal !== undefined) {
          return { status: refusal };
        }
        if (linkRefusal !== undefined) {
          throw invalidInput(`Invalid reminder: ${linkRefusal}`);
        }
        // Mapped for none of the player's targets (or none reached): nothing could deliver it.
        return { status: mapped ? 'permission-required' : 'unavailable' };
      }
      // One reminder per key: setting it replaces the previous one and, before
      // the write, stops the previous one's send that waits; a scheduler run
      // that fires the previous one meanwhile then fails to mark it and stops
      // its own send. A previous send of this reminder's content at its key
      // (an identical re-set) serves it and stays. A stop that fails fails the
      // set before anything is written, so the set is retried as a whole.
      const id = reminderEntryId(reminder.key);
      // A reminder set for a time already past is due now, not at that time,
      // so a burst of past-dated reminders queues behind those already due.
      const entry: NotificationScheduleEntry = {
        player,
        id,
        dueAt: formatNotificationInstant(Math.max(Date.parse(reminder.fireAt), at)),
        item: reminder,
      };
      const fingerprint = notificationSendFingerprint(request);
      let stopped = false;
      for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
        const held = await store.getScheduleEntry({ player, id });
        const previous = held?.entry.item.kind === 'reminder' ? held.entry.item : undefined;
        // Replacing a pending reminder is always allowed; a new one counts against the cap.
        if (
          (previous === undefined || previous.firedAt !== undefined)
          && await store.countPendingReminders(player) >= maxPendingNotificationReminders
        ) {
          return { status: 'capacity-exceeded' };
        }
        if (previous !== undefined) {
          const previousFingerprint = reminderFingerprint(player, previous);
          const identical = previous.fireAt === reminder.fireAt && previousFingerprint === fingerprint;
          if (!identical) {
            stopped = (await stopReminderSend(player, previous, previousFingerprint)) || stopped;
          }
        }
        const written = held === undefined
          ? (await store.createScheduleEntry(entry)) !== undefined
          : await store.updateScheduleEntry({ player, id, version: held.version, entry });
        if (written) {
          const pending = previous !== undefined && previous.firedAt === undefined;
          return { status: pending || stopped ? 'replaced' : 'scheduled' };
        }
      }
      throw busy(id);
    },

    async cancelReminder(session, raw) {
      const { player } = await authenticated(session);
      if (!isPlainObject(raw) || Object.keys(raw).some((name) => name !== 'key') || typeof raw.key !== 'string') {
        throw invalidInput('A reminder cancel names only its key.');
      }
      const issue = notificationKeyIssue(raw.key);
      if (issue !== undefined) {
        throw invalidInput(`key: ${issue}.`);
      }
      const id = reminderEntryId(raw.key);
      let stopped = false;
      for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
        const held = await store.getScheduleEntry({ player, id });
        if (held === undefined || held.entry.item.kind !== 'reminder') {
          return { cancelled: stopped };
        }
        const reminder = held.entry.item;
        const fingerprint = reminderFingerprint(player, reminder);
        // Before the removal, so a failure leaves the cancel to retry; and
        // after it, best effort, for a scheduler run that stored the send in
        // between (its own mark then fails and stops it too). Only this
        // reminder's content is stopped.
        stopped = (await stopReminderSend(player, reminder, fingerprint)) || stopped;
        if (await removeEntry(held)) {
          try {
            stopped = (await stopReminderSend(player, reminder, fingerprint)) || stopped;
          } catch (error) {
            report(error, 'reminders.stop');
          }
          return { cancelled: reminder.firedAt === undefined || stopped };
        }
      }
      throw busy(id);
    },

    async runScheduler(options = {}) {
      const limit = batchLimit(options.limit);
      const budgetMs = typeof options.budgetMs === 'number' && Number.isFinite(options.budgetMs) && options.budgetMs > 0
        ? options.budgetMs
        : defaultSchedulerBudgetMs;
      const elapsed = input.elapsedMs ?? (() => globalThis.performance.now());
      const startedAt = elapsed();
      const touched = new Map<string, NotificationDeliveryOutcome>();
      // One pace for the whole run: rows taken in an earlier round count.
      const pace = paceBudgets();
      let failed = 0;
      for (;;) {
        let more: boolean;
        let progressed: boolean;
        try {
          const entries = await runScheduleEntries(limit, touched);
          failed += entries.failed;
          const dispatched = await dispatchDueRows({ limit }, pace);
          failed += dispatched.failed;
          for (const result of dispatched.results) {
            touched.set(result.sendKey, result.outcome);
          }
          // Another round only while one may be due (a batch came back
          // full, and not only with sends the pace holds back) and this
          // round got somewhere. A schedule that cannot be read lists
          // nothing, so its batch is never full.
          more = entries.listed === limit
            || (dispatched.listed === limit && dispatched.paced < dispatched.listed);
          progressed = entries.handled > 0 || dispatched.results.length > 0;
        } catch (error) {
          // A round that fails keeps what earlier rounds did.
          failed += 1;
          report(error, 'scheduler.round');
          break;
        }
        if (!more || !progressed || elapsed() - startedAt >= budgetMs) {
          break;
        }
      }
      return {
        results: [...touched].map(([sendKey, outcome]) => ({ sendKey, outcome })),
        failed,
      };
    },

    async purge() {
      const at = nowMs();
      return store.purge({
        sendsChangedBefore: formatNotificationInstant(at - keyRetentionMs),
        historyBefore: formatNotificationInstant(at - historyRetentionMs),
        invalidEndpointsBefore: formatNotificationInstant(at - endpointPurgeDelayMs),
        staleEndpointsBefore: formatNotificationInstant(at - endpointStaleMs - endpointPurgeDelayMs),
        sessionEndpointsBefore: formatNotificationInstant(at),
      });
    },
  };
}

/**
 * Why a reminder's `link` cannot reach the player through `provider`, or
 * `undefined`. A provider whose entry needs a link (Devvit) needs the
 * reminder's or the topic mapping's, as the gate does at send time
 * (`link-missing`), and a given link must match the provider's mapping rule
 * for `link`, so a bad one is refused when it is set rather than spent when
 * it fires.
 */
function reminderLinkIssue(
  provider: RegisteredNotificationProvider,
  topic: NotificationTopicDeclaration,
  link: string | undefined,
): string | undefined {
  if (link !== undefined) {
    const pattern = provider.validation.mapping['link']?.pattern;
    if (pattern !== undefined) {
      let rule: RegExp;
      try {
        rule = new RegExp(pattern, 'u');
      } catch {
        return undefined;
      }
      if (!rule.test(link)) {
        return `link does not match provider ${provider.entry.provider}'s link rule.`;
      }
    }
    return undefined;
  }
  if (provider.entry.link && typeof topic.mapping?.['link'] !== 'string') {
    return `provider ${provider.entry.provider} sends need a link, and neither the reminder nor the topic mapping has one.`;
  }
  return undefined;
}

/** A scheduler batch: clamped to 1 to 1000; anything that is not a number is the default, 100. */
function batchLimit(limit: unknown): number {
  const asked = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 100;
  return Math.min(Math.max(asked, 1), 1000);
}

/**
 * A due row taken for the queue: queued (in flight, no holder) for one claim
 * lease. An attempted row stays attempted, and its lease ends before its
 * replay window does, so the take alone never abandons it.
 */
function takenRow(row: NotificationSendRow, at: number, leaseMs: number): NotificationSendRow {
  const leaseUntil = at + leaseMs;
  if (row.state.status !== 'in-flight' || !row.state.attempted) {
    return {
      ...row,
      state: {
        status: 'in-flight',
        leaseUntil: formatNotificationInstant(leaseUntil),
        attempted: false,
      },
    };
  }
  const windowEnd = row.firstAttemptedAt === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(row.firstAttemptedAt) + ambiguousReplayMs - 1;
  return {
    ...row,
    state: {
      status: 'in-flight',
      leaseUntil: formatNotificationInstant(
        windowEnd > at ? Math.min(leaseUntil, windowEnd) : leaseUntil,
      ),
      attempted: true,
      ...(row.state.attemptedAt === undefined ? {} : { attemptedAt: row.state.attemptedAt }),
    },
  };
}

/** A well-formed server reminder, with `fireAt` in the canonical form, or `NOTIFICATIONS_INVALID_INPUT`. */
function reminderOf(raw: unknown): NotificationStoredReminder {
  if (!isPlainObject(raw)) {
    throw invalidInput('A reminder is an object.');
  }
  const known = new Set(['key', 'topic', 'fireAt', 'templateData', 'link']);
  const unknown = Object.keys(raw).find((name) => !known.has(name));
  const keyIssue = typeof raw.key === 'string'
    ? notificationKeyIssue(raw.key)
    : 'expected a string';
  const dataIssue = raw.templateData === undefined
    ? undefined
    : notificationTemplateDataIssue(raw.templateData);
  let issue: string | undefined;
  if (unknown !== undefined) {
    issue = `${unknown}: not a reminder field`;
  } else if (keyIssue !== undefined) {
    issue = `key: ${keyIssue}`;
  } else if (!isBoundedText(raw.topic)) {
    issue = 'topic: expected a non-empty string';
  } else if (typeof raw.fireAt !== 'string' || raw.fireAt.length > 64 || !isNotificationTimestamp(raw.fireAt)) {
    issue = 'fireAt: expected RFC 3339 with an explicit offset';
  } else if (dataIssue !== undefined) {
    issue = `templateData: ${dataIssue}`;
  } else if (raw.link !== undefined && !isBoundedText(raw.link)) {
    issue = 'link: expected a non-empty string';
  }
  if (issue !== undefined) {
    throw invalidInput(`Invalid reminder: ${issue}.`);
  }
  const input = raw as unknown as NotificationReminderInput;
  return {
    kind: 'reminder',
    key: input.key,
    topic: input.topic,
    fireAt: normalizeNotificationTimestamp(input.fireAt),
    ...(input.templateData === undefined ? {} : { templateData: input.templateData }),
    ...(input.link === undefined ? {} : { link: input.link }),
  };
}

function noEndpoint(): NotificationDeliveryRefusal {
  return { status: 'unavailable', reason: 'no-endpoint' };
}

function invalidInput(message: string, cause?: unknown): NotificationError {
  return new NotificationError('NOTIFICATIONS_INVALID_INPUT', {
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function busy(key: string): NotificationError {
  return new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', {
    message: `The delivery ledger stayed busy for key ${key}; retry the send.`,
  });
}

function sessionOf(session: NotificationSession): NotificationSession {
  if (
    !isPlainObject(session)
    || !isBoundedText(session.player)
    || !isBoundedText(session.sessionId)
    || !isBoundedText(session.installationId)
    || (session.expiresAt !== undefined
      && (typeof session.expiresAt !== 'string' || !isNotificationTimestamp(session.expiresAt)))
  ) {
    throw new TypeError(
      'A notifications session names its player, session id, installation id, and an optional RFC 3339 expiresAt.',
    );
  }
  return session;
}

/** A well-formed send request, or `NOTIFICATIONS_INVALID_INPUT`. */
function sendRequestOf(raw: unknown): NotificationStoredSendRequest {
  if (!isPlainObject(raw)) {
    throw invalidInput('A send is an object.');
  }
  const known = new Set([
    'idempotencyKey',
    'player',
    'topic',
    'provider',
    'templateData',
    'data',
    'locale',
    'link',
  ]);
  const unknown = Object.keys(raw).find((key) => !known.has(key));
  const issue = unknown !== undefined ? `${unknown}: not a send field` : sendInputIssue(raw);
  if (issue !== undefined) {
    throw invalidInput(`Invalid send: ${issue}.`);
  }
  const input = raw as unknown as NotificationDeliverInput;
  return {
    idempotencyKey: input.idempotencyKey,
    player: input.player,
    topic: input.topic,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.templateData === undefined ? {} : { templateData: input.templateData }),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.link === undefined ? {} : { link: input.link }),
  };
}

function sendInputIssue(request: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof request.idempotencyKey !== 'string') {
    return 'idempotencyKey: expected a string';
  }
  const keyIssue = notificationKeyIssue(request.idempotencyKey);
  if (keyIssue !== undefined) {
    return `idempotencyKey: ${keyIssue}`;
  }
  const reserved = notificationReservedKeyPrefix(request.idempotencyKey);
  if (reserved !== undefined) {
    return `idempotencyKey: the ${reserved} prefix is reserved for the scheduler`;
  }
  for (const name of ['player', 'topic'] as const) {
    if (!isBoundedText(request[name])) {
      return `${name}: expected a non-empty string`;
    }
  }
  if (request.templateData !== undefined) {
    const issue = notificationTemplateDataIssue(request.templateData);
    if (issue !== undefined) {
      return `templateData: ${issue}`;
    }
  }
  if (request.data !== undefined) {
    const issue = notificationTemplateDataIssue(request.data, { stringsOnly: true });
    if (issue !== undefined) {
      return `data: ${issue}`;
    }
    // An open carries its topic and route in these keys; routing data never overrides them.
    const reserved = Object.keys(request.data as object).find(
      (key) => key === 'topic' || key === 'route',
    );
    if (reserved !== undefined) {
      return `data: the key ${reserved} is reserved for the open's own ${reserved}`;
    }
  }
  for (const name of ['provider', 'locale', 'link'] as const) {
    if (request[name] !== undefined && !isBoundedText(request[name])) {
      return `${name}: expected a non-empty string`;
    }
  }
  return undefined;
}

function isBoundedText(value: unknown, maxLength = maxTextLength): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Seconds a row waits after its holder failed before the provider call. */
const releaseBackoffMs = 60 * secondMs;

/** Each other send's counted entries, by send key. */
type SendHistory = ReadonlyMap<string, readonly NotificationDeliveryHistoryEntry[]>;

/**
 * The gate's history for a recipient on `provider`: each send once, on
 * `provider` when it reached it there, else at its earliest entry, oldest
 * first.
 */
function historyOn(history: SendHistory, provider: string): NotificationDeliveryHistoryEntry[] {
  return [...history.values()]
    .map((entries) =>
      entries.find((entry) => entry.provider === provider)
      ?? [...entries].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))[0])
    .filter((entry): entry is NotificationDeliveryHistoryEntry => entry !== undefined)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * The row as it was before a claim, due no sooner than a short backoff from
 * `at`, but never so late that an ambiguous row's replay window closes on
 * the backoff alone.
 */
function backedOff(row: NotificationSendRow, at: number): NotificationSendRow {
  const notBefore = at + releaseBackoffMs;
  if (row.state.status === 'deferred') {
    return {
      ...row,
      state: {
        ...row.state,
        until: formatNotificationInstant(Math.max(Date.parse(row.state.until), notBefore)),
      },
    };
  }
  if (row.state.status === 'in-flight') {
    // An attempted row's replays end a day after its first attempt; the
    // backoff does not close that window early, unless it already closed.
    const windowEnd = row.state.attempted && row.firstAttemptedAt !== undefined
      ? Date.parse(row.firstAttemptedAt) + ambiguousReplayMs - 1
      : Number.POSITIVE_INFINITY;
    const until = windowEnd > at ? Math.min(notBefore, windowEnd) : notBefore;
    return {
      ...row,
      state: {
        ...row.state,
        leaseUntil: formatNotificationInstant(Math.max(Date.parse(row.state.leaseUntil), until)),
      },
    };
  }
  return row;
}

/**
 * The gate's refusals from the steps before the permission step
 * (`evaluateNotificationDelivery`: topic, channel, purpose, recipient,
 * link), which a send-time permission read cannot change. Typed by the
 * gate's reason unions, so a misspelt reason does not compile; a gate that
 * moved the permission step earlier must update this list (the
 * permission-order test in service.test.ts covers both sides).
 */
const earlyGateReasons: ReadonlySet<NotificationDeliveryRefusal['reason']> = new Set<
  NotificationDeliveryRefusal['reason']
>(['topic-unknown', 'channel-unsupported', 'purpose-unsupported', 'no-endpoint', 'link-missing']);

/** Writes that must not fail a settled delivery are tried this often. */
const maxSideWriteAttempts = 3;

/** Runs `write` up to `maxSideWriteAttempts` times with a short pause; reports only the last failure and never throws. */
async function withRetries(write: () => Promise<void>, onFailure: (error: unknown) => void): Promise<void> {
  for (let attempt = 0; attempt < maxSideWriteAttempts; attempt += 1) {
    try {
      await write();
      return;
    } catch (error) {
      if (attempt === maxSideWriteAttempts - 1) {
        onFailure(error);
      } else {
        await pause(25 * (attempt + 1));
      }
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A provider's answer when it is one of the five kinds, else `undefined`. */
function deliveryAnswerOf(answer: unknown): NotificationRemoteDeliveryAnswer | undefined {
  if (!isPlainObject(answer)) {
    return undefined;
  }
  switch (answer.status) {
    case 'accepted':
      return typeof answer.providerMessageId === 'string'
        ? { status: 'accepted', providerMessageId: answer.providerMessageId }
        : { status: 'accepted' };
    case 'unregistered':
      return { status: 'unregistered' };
    case 'rate-limited':
      return typeof answer.retryAfterSeconds === 'number'
        ? { status: 'rate-limited', retryAfterSeconds: answer.retryAfterSeconds }
        : { status: 'rate-limited' };
    case 'rejected':
      if (answer.reason !== 'configuration' && answer.reason !== 'recipient' && answer.reason !== 'agreement') {
        return undefined;
      }
      return typeof answer.providerCode === 'string'
        ? {
            status: 'rejected',
            reason: answer.reason,
            providerCode: answer.providerCode.slice(0, 64),
          }
        : { status: 'rejected', reason: answer.reason };
    case 'ambiguous':
      return { status: 'ambiguous' };
    default:
      return undefined;
  }
}
