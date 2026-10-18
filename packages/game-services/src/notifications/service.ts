import {
  assertNotificationConsentRecord,
  assertNotificationDeployment,
  assertNotificationEndpointRegistration,
  assertRecordNotificationNoticeInput,
  evaluateNotificationDelivery,
  isNotificationTimestamp,
  isSameNotificationNotice,
  isValidNotificationTimeZone,
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

import type {
  NotificationRemoteDeliveryAnswer,
  NotificationRemoteRecipient,
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
  isNotificationRowDue,
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
 *   in-flight rows whose lease ended (a queued job that was lost, a device
 *   endpoint, a scheduled send). A direct caller replays its own in-flight
 *   platform send by sending the key again after the lease.
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
/** Longest accepted text for ids, locales, links, and versions. */
const maxTextLength = 2048;
/** Longest accepted device address value. */
const maxAddressLength = 4096;
/** Largest consent evidence envelope, as JSON. */
const maxEvidenceBytes = 16_384;

/** An authenticated game-services session, as the deployment's identity service resolves it. */
export interface NotificationSession {
  readonly player: string;
  /** Stable for the session's life (its refresh family); its end unbinds what it registered. */
  readonly sessionId: string;
  /** The guest session's installation id. */
  readonly installationId: string;
  /** When the session ends on its own, RFC 3339; endpoints it registered count as unbound from then. */
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
  readonly onError?: (error: unknown, context: { readonly operation: string; readonly sendKey?: string }) => void;
}

export interface NotificationDueResult {
  readonly sendKey: string;
  /** The send's result after the replay. */
  readonly outcome: NotificationDeliveryOutcome;
}

export interface NotificationService {
  /** The registry entries and served targets the backend publishes. */
  providers(): NotificationProviderRegistrySnapshot;
  /** Appends a consent record for the session's player, dated by the backend. */
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
    input?: { readonly channel?: NotificationNoticeChannel },
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

/** A gate caller error (such as missing template data): the send cannot be made as asked. */
class NotificationSendInputError extends Error {
  override readonly name = 'NotificationSendInputError';
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
  | { readonly kind: 'set'; readonly row: NotificationSendRow; readonly delivered: boolean };

type RunMode = 'job' | 'retry' | 'due';

export function createNotificationService(input: CreateNotificationServiceInput): NotificationService {
  const { store, registry, catalog } = input;
  const deployment = input.deployment === undefined
    ? undefined
    : assertNotificationDeployment(input.deployment);
  const rules = deployment?.advertisingRules ?? 'none';
  const leaseMs = (input.claimLeaseSeconds ?? defaultClaimLeaseSeconds) * secondMs;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > dayMs) {
    throw new TypeError('claimLeaseSeconds must be a whole number of seconds up to one day.');
  }
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
  const report = (error: unknown, operation: string, sendKey?: string): void => {
    try {
      input.onError?.(error, { operation, ...(sendKey === undefined ? {} : { sendKey }) });
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
    const id = await input.resolvePlatformRecipient?.({
      provider: provider.entry.provider,
      player: request.player,
    });
    const registration = await store.getPlatformRegistration({
      player: request.player,
      provider: provider.entry.provider,
    });
    const resolved = typeof id === 'string' && id.length > 0;
    return {
      provider,
      rowKey: request.idempotencyKey,
      ...(resolved ? { platformId: id } : {}),
      resolved,
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
    const named = request.provider === undefined ? undefined : registry.provider(request.provider);
    const scope = request.provider === undefined
      ? registry.providers
      : named === undefined
        ? []
        : [named];
    const resolved: Recipient[] = [];
    const unresolved: Recipient[] = [];
    for (const provider of scope) {
      if (provider.entry.addressing === 'device') {
        const endpoints = (await store.listEndpoints({
          player: request.player,
          provider: provider.entry.provider,
        }))
          .filter((endpoint) => usable(endpoint, at))
          .sort((left, right) => compareText(left.installationId, right.installationId));
        if (endpoints.length === 0) {
          unresolved.push({ provider, rowKey: request.idempotencyKey, resolved: false });
        }
        resolved.push(...endpoints.map((endpoint) =>
          deviceRecipient(provider, request.idempotencyKey, endpoint)));
      } else {
        const recipient = await platformRecipient(provider, request);
        (recipient.resolved ? resolved : unresolved).push(recipient);
      }
    }
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
   * Delivered sends and in-flight ones, oldest first, within the longest
   * limit window; the send being made is left out, including its earlier
   * delivery to another endpoint.
   */
  const historyFor = async (
    player: string,
    excluding: string,
    at: number,
  ): Promise<NotificationDeliveryHistoryEntry[]> => {
    const delivered = await store.listHistory({
      player,
      since: formatNotificationInstant(at - longestWindowMs),
    });
    const inFlight = await store.listInFlightSends(player);
    return [
      ...delivered
        .filter((sent) => sent.sendKey !== excluding)
        .map((sent) => ({ provider: sent.provider, topic: sent.topic, at: sent.at })),
      ...inFlight
        .filter((send) => send.key !== excluding)
        .flatMap((send) => [...new Set(send.rows
          .filter((row) => row.state.status === 'in-flight')
          .map((row) => row.provider))]
          .map((provider) => ({ provider, topic: send.request.topic, at: send.changedAt }))),
    ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
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
    const delaySeconds = prior?.delaySeconds
      ?? (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : defaultRetryAfterSeconds);
    const attempts = prior?.attempts ?? 0;
    // The first deferral waits the provider's delay; later ones back off
    // exponentially from it, with up to 25% jitter so retries spread out.
    const jitter = attempts === 0 ? 1 : 1 + Math.min(Math.max(random(), 0), 0.999) * 0.25;
    const delayMs = delaySeconds * 2 ** attempts * secondMs * jitter;
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
      return await recipient.provider.delivery.send({
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
    const history = await historyFor(request.player, request.idempotencyKey, at);
    const permissions = new Map<string, NotificationPermissionState | undefined>();
    const rows: NotificationSendRow[] = [];
    const refusals: NotificationDeliveryRefusal[] = [];
    for (const recipient of recipients) {
      const id = recipient.provider.entry.provider;
      if (!permissions.has(id)) {
        permissions.set(id, await readServerPermission(recipient.provider, request));
      }
      const { decision } = decide(
        request,
        origin,
        recipient,
        consent,
        history,
        permissions.get(id),
        at,
      );
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

  const eligible = (mode: RunMode, send: NotificationStoredSend, row: NotificationSendRow, at: number): boolean => {
    switch (mode) {
      case 'job':
        return row.state.status === 'in-flight'
          && (!row.state.attempted || Date.parse(row.state.leaseUntil) <= at);
      case 'retry':
        return row.state.status === 'in-flight'
          && row.state.attempted
          && Date.parse(row.state.leaseUntil) <= at
          && row.installationId === undefined
          && !send.scheduled;
      case 'due':
        return isNotificationRowDue(send, row, at);
    }
  };

  /** Applies a row change while this claim still holds the row; a stale claim changes nothing. */
  const complete = async (
    sendKey: string,
    claimed: NotificationSendRow,
    token: string,
    change: RowChange,
    at: number,
  ): Promise<void> => {
    for (let attempt = 0; attempt < maxLedgerAttempts; attempt += 1) {
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
    let claimed: { readonly send: NotificationStoredSend; readonly row: NotificationSendRow; readonly token: string } | undefined;
    let at = nowMs();
    for (let attempt = 0; attempt < maxLedgerAttempts && claimed === undefined; attempt += 1) {
      at = nowMs();
      const held = await store.getSend(sendKey);
      const row = held?.send.rows.find((candidate) =>
        candidate.key === rowKey && candidate.provider === provider);
      if (held === undefined || row === undefined || !eligible(mode, held.send, row, at)) {
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
      const claimedRow: NotificationSendRow = {
        ...row,
        state: {
          status: 'in-flight',
          leaseUntil: formatNotificationInstant(at + leaseMs),
          claim: token,
          attempted: true,
        },
      };
      const next: NotificationStoredSend = {
        ...held.send,
        // From a due replay on, the scheduler owns the send.
        scheduled: held.send.scheduled || mode === 'due',
        rows: rowsWith(held.send, row, { kind: 'set', row: claimedRow, delivered: false }),
        changedAt: formatNotificationInstant(at),
      };
      if (await store.updateSend({ key: sendKey, version: held.version, send: next })) {
        claimed = { send: next, row: claimedRow, token };
      }
    }
    if (claimed === undefined) {
      throw busy(sendKey);
    }
    const { send, row, token } = claimed;
    const registered = registry.provider(row.provider);
    if (registered === undefined) {
      // The deployment no longer serves this provider.
      await complete(sendKey, row, token, { kind: 'remove' }, at);
      return { refusal: noEndpoint() };
    }
    const recipient = await recipientOfRow(registered, send.request, row, at);
    let evaluated: ReturnType<typeof decide>;
    try {
      const consent = await store.listConsent(send.request.player);
      const history = await historyFor(send.request.player, sendKey, at);
      const serverPermission = await readServerPermission(registered, send.request);
      evaluated = decide(send.request, send.origin, recipient, consent, history, serverPermission, at);
    } catch (error) {
      if (error instanceof NotificationSendInputError) {
        // A send that cannot be made as asked fails once, not on every replay.
        await complete(sendKey, row, token, { kind: 'remove' }, at);
        throw invalidInput(error.message, error);
      }
      // Anything else (a host read that failed) keeps the claim; the lease retries it.
      throw error;
    }
    const { decision, topic } = evaluated;
    const backoff = row.rateLimit === undefined ? {} : { rateLimit: row.rateLimit };
    const base = {
      key: row.key,
      provider: row.provider,
      ...(row.installationId === undefined ? {} : { installationId: row.installationId }),
    };
    if (decision.status === 'deferred') {
      await complete(
        sendKey,
        row,
        token,
        {
          kind: 'set',
          delivered: false,
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
        // Counted before the row is settled: the provider took it whatever happens next.
        await store.addHistory({
          sendKey,
          provider: row.provider,
          player: send.request.player,
          topic: send.request.topic,
          at: formatNotificationInstant(answeredAt),
        });
        await complete(
          sendKey,
          row,
          token,
          { kind: 'set', delivered: true, row: { ...base, state: { status: 'delivered' } } },
          answeredAt,
        );
        return {};
      case 'ambiguous':
        // The provider may have sent it: the claim is kept for the lease.
        await complete(
          sendKey,
          row,
          token,
          {
            kind: 'set',
            delivered: false,
            row: {
              ...base,
              ...backoff,
              state: {
                status: 'in-flight',
                leaseUntil: formatNotificationInstant(answeredAt + leaseMs),
                claim: token,
                attempted: true,
              },
            },
          },
          answeredAt,
        );
        return {};
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
        if (answer.reason === 'agreement') {
          // The host says the recipient has not agreed: a topic that needs an
          // agreement stops until the player agrees again.
          await store.appendConsent({
            player: send.request.player,
            record: {
              kind: 'host-agreement',
              topic: send.request.topic,
              state: 'denied',
              source: 'provider',
            },
            at: formatNotificationInstant(answeredAt),
          });
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
            delivered: false,
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

  /** The send's answer after its rows ran: the stored outcome, else the best refusal. */
  const settle = async (
    sendKey: string,
    refusals: readonly NotificationDeliveryRefusal[],
  ): Promise<NotificationDeliveryOutcome> => {
    const held = await store.getSend(sendKey);
    const stored = held === undefined ? undefined : notificationSendOutcome(held.send);
    return stored ?? bestNotificationOutcome(refusals) ?? noEndpoint();
  };

  const runInline = async (
    sendKey: string,
    rows: readonly NotificationSendRow[],
    mode: RunMode,
  ): Promise<NotificationDeliveryRefusal[]> => {
    const refusals: NotificationDeliveryRefusal[] = [];
    for (const row of rows) {
      const { refusal } = await runRow(sendKey, row.provider, row.key, mode);
      if (refusal !== undefined) {
        refusals.push(refusal);
      }
    }
    return refusals;
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
      await store.updateSend({ key: send.key, version, send: undefined });
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
    const jobRefusals = await runInline(send.key, queued, 'job');
    return settle(send.key, [...refusals, ...jobRefusals]);
  };

  return {
    providers: () => registry.snapshot(),

    async recordConsent(session, record) {
      const { player } = sessionOf(session);
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
      const { at: _at, ...withoutAt } = checked;
      return store.appendConsent({ player, record: withoutAt as NotificationConsentRecordInput, at });
    },

    async listConsent(session) {
      return store.listConsent(sessionOf(session).player);
    },

    async registerEndpoint(session, request) {
      const current = sessionOf(session);
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
        throw invalidInput(`Provider ${provider.entry.provider} cannot send to a ${address.kind} address.`);
      }
      if (address.value.length > maxAddressLength || hasControlCharacter(address.value)) {
        throw invalidInput('The device address is out of bounds.');
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
      const current = sessionOf(session);
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
      return noticesOf(sessionOf(session).player, nowMs());
    },

    async recordNoticeShown(session, notice, options = {}) {
      const { player } = sessionOf(session);
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
      const channel = options.channel ?? 'in-game';
      if (channel !== 'in-game' && channel !== 'push' && channel !== 'other') {
        throw invalidInput('channel: expected in-game, push, or other.');
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
          const expired = send.rows.filter((row) => eligible('retry', send, row, at));
          if (expired.length > 0 && notificationSendOutcome(send)?.status === 'in-flight') {
            // The claim's lease expired: this caller is the next claimer and replays it.
            const refusals = await runInline(key, expired, 'retry');
            return settle(key, refusals);
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
      if (!isPlainObject(job) || !isBoundedText(job.sendKey) || !isBoundedText(job.provider) || typeof job.rowKey !== 'string') {
        throw invalidInput('A dispatch job names its send key, provider, and row key.');
      }
      await runRow(job.sendKey, job.provider, job.rowKey, 'job');
    },

    async dispatchDue(options = {}) {
      const limit = options.limit ?? 100;
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
          const due = held.send.rows.filter((row) => isNotificationRowDue(held.send, row, at));
          if (due.length === 0) {
            continue;
          }
          const refusals = await runInline(sendKey, due, 'due');
          results.push({ sendKey, outcome: await settle(sendKey, refusals) });
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
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
