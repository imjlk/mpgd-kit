import {
  assertNotificationConsentRecord,
  assertNotificationDeployment,
  assertNotificationEndpointRegistration,
  assertRecordNotificationNoticeInput,
  evaluateNotificationDelivery,
  isNotificationTimestamp,
  isSameNotificationNotice,
  isValidNotificationTimeZone,
  latestNotificationConsent,
  listNotificationNotices,
  normalizeNotificationTimestamp,
  NotificationError,
  notificationKeyIssue,
  notificationNoticeCopyIssues,
  notificationNoticeTopic,
  notificationReservedKeyPrefix,
  notificationSendFingerprint,
  notificationTemplateDataIssue,
  type NotificationConsentRecord,
  type NotificationDeliveryDecision,
  type NotificationDeliveryHistoryEntry,
  type NotificationDeliveryOutcome,
  type NotificationDeliveryRefusal,
  type NotificationDeployment,
  type NotificationNotice,
  type NotificationNoticeIdentity,
  type NotificationPermissionState,
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
  type NotificationPurgeCounts,
  type NotificationRateLimitState,
  type NotificationSendOrigin,
  type NotificationSendRow,
  type NotificationStore,
  type NotificationStoredEndpoint,
  type NotificationStoredSend,
  type NotificationStoredSendRequest,
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
/**
 * Client-written consent records a player may add per rolling day. It is
 * generous: it only stops a client that writes in a loop, since every send
 * reads the player's whole history. It is checked before the write, so
 * concurrent writes may pass it by a few.
 */
export const maxClientNotificationConsentRecordsPerDay = 200;

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
    },
  ) => void;
}

export interface NotificationDueResult {
  readonly sendKey: string;
  /** The send's result after the replay. */
  readonly outcome: NotificationDeliveryOutcome;
}

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
  /** Replays up to `limit` sends with a due row; one failing send never stops the others. */
  dispatchDue(input?: { readonly limit?: number }): Promise<{
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
  ): void => {
    const where = typeof context === 'string' ? { sendKey: context } : context;
    try {
      input.onError?.(error, {
        operation,
        ...(where.sendKey === '' ? {} : { sendKey: where.sendKey }),
        ...(where.provider === undefined ? {} : { provider: where.provider }),
        ...(where.rowKey === undefined ? {} : { rowKey: where.rowKey }),
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
   * `no-endpoint`).
   */
  const recipientsOf = async (
    request: NotificationStoredSendRequest,
    at: number,
  ): Promise<readonly Recipient[]> => {
    let scope: readonly RegisteredNotificationProvider[] = registry.providers;
    if (request.provider !== undefined) {
      const named = registry.provider(request.provider);
      scope = named === undefined ? [] : [named];
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
      report(error, 'provider.send', request.idempotencyKey);
      return { status: 'ambiguous' };
    }
  };

  /**
   * The rows a new send stores, after a first gate check per recipient:
   * allowed recipients become queued rows, deferred ones deferred rows, and
   * refusals are answered but not stored. A caller error throws before
   * anything is stored.
   */
  const plan = async (
    request: NotificationStoredSendRequest,
    origin: NotificationSendOrigin,
    at: number,
  ): Promise<{ readonly rows: NotificationSendRow[]; readonly refusals: NotificationDeliveryRefusal[] }> => {
    const recipients = await recipientsOf(request, at);
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
            leaseUntil: formatNotificationInstant(at + leaseMs),
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
        // A queued delivery runs once; an attempted one is replayed only after its lease.
        return row.state.status === 'in-flight' && !row.state.attempted;
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
        // A due replay marks the send as the scheduler's (S2 reads the flag).
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
      return store.appendConsent({ player, record: withoutAt as NotificationConsentRecordInput, at });
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
      // The batch size is clamped to 1 to 1000; anything that is not a number is the default, 100.
      const asked = typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.floor(options.limit)
        : 100;
      const limit = Math.min(Math.max(asked, 1), 1000);
      const keys = await store.listDueSends({ at: formatNotificationInstant(nowMs()), limit });
      const results: NotificationDueResult[] = [];
      let failed = 0;
      for (const sendKey of keys) {
        try {
          const held = await store.getSend(sendKey);
          if (held === undefined) {
            continue;
          }
          const at = nowMs();
          const due = held.send.rows.filter((row) => isNotificationRowDue(row, at));
          if (due.length === 0) {
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
      return { results, failed };
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
      ? Date.parse(row.firstAttemptedAt) + notificationAmbiguousReplayHours * 3_600_000 - 1
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
