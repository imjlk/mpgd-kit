import { AsyncLocalStorage } from 'node:async_hooks';

import {
  createFcmProviderRegistration,
  createInMemoryNotificationStore,
  createNotificationProviderRegistry,
  createNotificationService,
  createNotificationServiceCatalog,
  maxClientNotificationConsentRecordsPerDay,
  NotificationConsentRateLimitError,
  parseFcmServiceAccount,
  type CreateNotificationServiceInput,
  type NotificationDispatchJob,
  type NotificationProviderRegistration,
  type NotificationService,
  type NotificationSession,
  type NotificationStore,
} from '@mpgd/game-services/notifications';
import {
  createAitFunctionalMessageDeliveryProvider,
  type CreateAitFunctionalMessageDeliveryProviderOptions,
} from '@mpgd/game-services/notifications/ait-functional-delivery';
import {
  assertNotificationDeployment,
  isNotificationTimestamp,
  NotificationError,
  notificationsProtocolVersion,
} from '@mpgd/platform/notifications';

import { createD1NotificationStore } from './notificationsD1.js';

/**
 * Notifications v2 in the game-services Worker (RFC "Server"): the
 * authenticated routes a game client calls, the service-binding RPC a game
 * server sends through, the dispatch queue consumer, and the cron: purges,
 * then the scheduler (server reminders, consent notice pushes, and due rows).
 */

/** Resolves a game-services session from the Authorization header. */
export interface GameServicesNotificationsAuthBinding {
  /**
   * The authenticated session, or `null`/`undefined` when the header does
   * not resolve. `sessionId` is stable for the session's life (its refresh
   * family) and `installationId` is the guest session's installation;
   * `expiresAt` is when the session ends on its own.
   */
  authenticateNotificationSession(input: { readonly authorization: string }): Promise<
    | {
        readonly playerId: string;
        readonly sessionId: string;
        readonly installationId: string;
        readonly expiresAt?: string;
      }
    | null
    | undefined
  >;
}

/** Resolves a player's recipient id on a platform-user provider (an Apps in Toss user key). */
export interface GameServicesNotificationsIdentityBinding {
  resolveNotificationRecipient(input: {
    readonly provider: string;
    readonly playerId: string;
  }): Promise<string | null | undefined>;
}

export interface GameServicesNotificationsEnv {
  readonly DB?: D1Database;
  readonly MPGD_STORE?: 'memory' | 'd1';
  /** The game's notification topic catalog (a JSON var); notifications are off without it. */
  readonly MPGD_NOTIFICATIONS_CATALOG?: unknown;
  /** The deployment settings (a JSON var): advertisingRules, advertisingSender, and the zone. */
  readonly MPGD_NOTIFICATIONS_DEPLOYMENT?: unknown;
  /** The Firebase service-account key file (a secret, JSON); enables the FCM provider. */
  readonly FCM_SERVICE_ACCOUNT?: unknown;
  /** Overrides the service account's project id. */
  readonly FCM_PROJECT_ID?: string;
  /**
   * The Apps in Toss partner API client certificate (a Workers mTLS
   * binding); with `MPGD_AIT_NOTIFICATIONS`, it enables the Apps in Toss
   * functional-message provider for the `ait` target.
   */
  readonly AIT_PARTNER_MTLS?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  /**
   * The Apps in Toss provider's settings (a JSON var): `recipientKey`
   * (`toss-user` or `anonymous`), and optionally `baseUrl`, `timeoutMs`,
   * `agreementErrorCodes`, `agreementFailReasons`, `recipientErrorCodes`.
   */
  readonly MPGD_AIT_NOTIFICATIONS?: unknown;
  readonly GAME_SERVICES_NOTIFICATIONS_AUTH?: GameServicesNotificationsAuthBinding;
  readonly GAME_SERVICES_NOTIFICATIONS_IDENTITY?: GameServicesNotificationsIdentityBinding;
  /** The dispatch queue's producer; without it fan-out runs inline. */
  readonly NOTIFICATIONS_QUEUE?: Queue<NotificationDispatchJob>;
  /**
   * Items one scheduler round takes, for each of its two steps (due
   * reminders and notice checks, then due sends); 25 by default, at most
   * 100, and never more than one round of `MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET`.
   * A cron run goes on in rounds until nothing is due, its time budget is
   * used, or another round would cross the subrequest budget.
   */
  readonly MPGD_NOTIFICATIONS_DUE_BATCH?: string;
  /**
   * Wall time one cron run's scheduler may use, in seconds; 20 by default.
   * A value that is not shorter than the cron period is rejected so the next
   * trigger does not overlap this run. The timer starts after the purge and
   * is checked only between rounds.
   */
  readonly MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS?: string;
  /**
   * D1 calls, queue sends, identity lookups, and provider fetches one
   * scheduled invocation may make before it stops. Counted on that
   * invocation only, not on the isolate. 1,000 by default, under the
   * Workers Paid subrequest cap (10,000 as of 2026-02-11, previously 1,000).
   */
  readonly MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET?: string;
}

export type WorkerNotifications =
  | { readonly status: 'disabled' }
  | { readonly status: 'ready'; readonly service: NotificationService }
  | { readonly status: 'misconfigured'; readonly error: Error };

/** The context the notifications service gives each failure it reports. */
type NotificationReportContext = Parameters<NonNullable<CreateNotificationServiceInput['onError']>>[1];

export const notificationsRoutePrefix = '/game-services/notifications';
/** Largest request body a notifications route reads. */
const maxBodyBytes = 64 * 1024;

/**
 * What the Worker logs of a failure the notifications service reports. A
 * provider's own failure (the service marks it `fromProvider`, and reports
 * it as `provider.send`) may quote a device token or a credential, so only
 * its name is logged. The service wraps every other provider-side error in
 * its own message before a report, so any other failure (`dispatch` and
 * `dispatchDue` included) is the store's or the kit's, such as a missing
 * table or a busy ledger, and its cause is logged cut to 120 characters, so
 * it can be fixed.
 */
export function notificationFailureCause(
  error: unknown,
  context: Pick<NotificationReportContext, 'operation' | 'fromProvider'>,
): string {
  return context.fromProvider === true || context.operation === 'provider.send'
    ? errorName(error)
    : describeFailure(error);
}

const servicesByEnv = new WeakMap<object, WorkerNotifications>();
const memoryStoresByEnv = new WeakMap<object, NotificationStore>();
const reportedMisconfiguration = new WeakSet<object>();
const reportedUnreadyConsumer = new WeakSet<object>();
const reportedMissingSessionBinding = new WeakSet<object>();

/**
 * The notifications service for this environment, built once per env
 * object (one per isolate): `disabled` without a catalog, `misconfigured`
 * (logged once) when the catalog, the deployment, or a provider's
 * credentials do not validate. The FCM token cache lives in the cached
 * provider, so an isolate mints one token per hour, not one per request.
 */
export function resolveWorkerNotifications(env: GameServicesNotificationsEnv): WorkerNotifications {
  const cached = servicesByEnv.get(env);
  if (cached !== undefined) {
    return cached;
  }
  let built: WorkerNotifications;
  try {
    built = buildWorkerNotifications(env);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!reportedMisconfiguration.has(env)) {
      reportedMisconfiguration.add(env);
      console.error('GameServices Worker notifications are misconfigured:', failure.message);
    }
    built = { status: 'misconfigured', error: failure };
  }
  servicesByEnv.set(env, built);
  return built;
}

/**
 * The delivery providers this Worker serves. FCM serves android and ios
 * when its service account is configured. The Apps in Toss functional
 * message provider serves `ait` when its mTLS binding and settings are
 * configured; it resolves recipients through the identity binding, which it
 * therefore requires. Half a configuration is refused, so a deployment
 * never runs without a provider it meant to have.
 */
export function workerNotificationProviders(
  env: GameServicesNotificationsEnv,
): NotificationProviderRegistration[] {
  const providers: NotificationProviderRegistration[] = [];
  const account = env.FCM_SERVICE_ACCOUNT;
  if (account !== undefined && !(typeof account === 'string' && account.trim() === '')) {
    providers.push(createFcmProviderRegistration({
      serviceAccount: parseFcmServiceAccount(account),
      ...(env.FCM_PROJECT_ID === undefined || env.FCM_PROJECT_ID === '' ? {} : { projectId: env.FCM_PROJECT_ID }),
      fetch: countingFetch((input, init) => globalThis.fetch(input, init)),
    }));
  }
  const aitSettings = parseJsonVar(env.MPGD_AIT_NOTIFICATIONS, 'MPGD_AIT_NOTIFICATIONS');
  if (aitSettings !== undefined || env.AIT_PARTNER_MTLS !== undefined) {
    if (env.AIT_PARTNER_MTLS === undefined || aitSettings === undefined) {
      throw new Error(
        'The Apps in Toss provider needs both the AIT_PARTNER_MTLS binding and MPGD_AIT_NOTIFICATIONS.',
      );
    }
    if (env.GAME_SERVICES_NOTIFICATIONS_IDENTITY === undefined) {
      throw new Error(
        'The Apps in Toss provider needs the GAME_SERVICES_NOTIFICATIONS_IDENTITY binding to resolve recipients.',
      );
    }
    const settings = aitProviderSettings(aitSettings);
    let provider: ReturnType<typeof createAitFunctionalMessageDeliveryProvider>;
    try {
      provider = createAitFunctionalMessageDeliveryProvider({
        ...settings,
        mtls: countingMtls(env.AIT_PARTNER_MTLS),
      });
    } catch (error) {
      // The provider checks the base URL and the timeout range; name the setting they came from.
      throw new Error(
        `MPGD_AIT_NOTIFICATIONS: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    providers.push({ entry: provider.entry, delivery: provider, targets: ['ait'] });
  }
  return providers;
}

/** `MPGD_AIT_NOTIFICATIONS`, checked field by field: a typo fails at startup, not at the first send. */
function aitProviderSettings(value: unknown): Omit<CreateAitFunctionalMessageDeliveryProviderOptions, 'mtls'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MPGD_AIT_NOTIFICATIONS must be an object.');
  }
  const settings = value as Readonly<Record<string, unknown>>;
  const known = new Set([
    'recipientKey',
    'baseUrl',
    'timeoutMs',
    'agreementErrorCodes',
    'agreementFailReasons',
    'recipientErrorCodes',
  ]);
  const unknownField = Object.keys(settings).find((key) => !known.has(key));
  if (unknownField !== undefined) {
    throw new Error(
      `MPGD_AIT_NOTIFICATIONS has no field ${unknownField}; it takes ${[...known].join(', ')}.`,
    );
  }
  const { recipientKey, baseUrl, timeoutMs } = settings;
  if (recipientKey !== 'toss-user' && recipientKey !== 'anonymous') {
    throw new Error("MPGD_AIT_NOTIFICATIONS.recipientKey must be 'toss-user' or 'anonymous'.");
  }
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new Error('MPGD_AIT_NOTIFICATIONS.baseUrl must be a string.');
  }
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
    throw new Error('MPGD_AIT_NOTIFICATIONS.timeoutMs must be a number.');
  }
  const codes = (name: string): readonly string[] | undefined => {
    const list = settings[name];
    if (list === undefined) {
      return undefined;
    }
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
      throw new Error(`MPGD_AIT_NOTIFICATIONS.${name} must be a list of strings.`);
    }
    return list as readonly string[];
  };
  const agreementErrorCodes = codes('agreementErrorCodes');
  const agreementFailReasons = codes('agreementFailReasons');
  const recipientErrorCodes = codes('recipientErrorCodes');
  return {
    recipientKey,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(agreementErrorCodes === undefined ? {} : { agreementErrorCodes }),
    ...(agreementFailReasons === undefined ? {} : { agreementFailReasons }),
    ...(recipientErrorCodes === undefined ? {} : { recipientErrorCodes }),
  };
}

function buildWorkerNotifications(env: GameServicesNotificationsEnv): WorkerNotifications {
  if (env.MPGD_NOTIFICATIONS_CATALOG === undefined) {
    return { status: 'disabled' };
  }
  const registry = createNotificationProviderRegistry(workerNotificationProviders(env));
  const declared = parseJsonVar(env.MPGD_NOTIFICATIONS_DEPLOYMENT, 'MPGD_NOTIFICATIONS_DEPLOYMENT');
  const deployment = declared === undefined ? undefined : assertNotificationDeployment(declared);
  const catalog = createNotificationServiceCatalog(
    parseJsonVar(env.MPGD_NOTIFICATIONS_CATALOG, 'MPGD_NOTIFICATIONS_CATALOG'),
    { registry, ...(deployment === undefined ? {} : { deployment }) },
  );
  const identity = env.GAME_SERVICES_NOTIFICATIONS_IDENTITY;
  const queue = env.NOTIFICATIONS_QUEUE;
  const service = createNotificationService({
    store: notificationStoreOf(env),
    registry,
    catalog,
    ...(deployment === undefined ? {} : { deployment }),
    ...(identity === undefined
      ? {}
      : {
          resolvePlatformRecipient: async ({ provider, player }) => {
            takeCronOperation();
            return (await identity.resolveNotificationRecipient({ provider, playerId: player })) ?? undefined;
          },
        }),
    ...(queue === undefined
      ? {}
      : {
          queue: {
            async enqueue(jobs) {
              // A queue batch carries at most 100 messages, and each batch is one subrequest.
              for (let start = 0; start < jobs.length; start += 100) {
                takeCronOperation();
                await queue.sendBatch(jobs.slice(start, start + 100).map((body) => ({ body })));
              }
            },
          },
        }),
    elapsedMs: () => notificationCronElapsed(),
    onError(error, context) {
      console.error(
        'Notifications:',
        context.operation,
        context.sendKey ?? '',
        context.provider ?? '',
        notificationFailureCause(error, context),
      );
    },
  });
  return { status: 'ready', service };
}

function notificationStoreOf(env: GameServicesNotificationsEnv): NotificationStore {
  if (env.MPGD_STORE !== 'd1' && env.NOTIFICATIONS_QUEUE !== undefined) {
    // The queue consumer and the cron run in other isolates, which cannot see
    // this isolate's memory: every queued send would vanish.
    throw new Error(
      'NOTIFICATIONS_QUEUE needs MPGD_STORE = "d1"; the memory store is per isolate.',
    );
  }
  if (env.MPGD_STORE === 'd1') {
    if (env.DB === undefined) {
      throw new Error('MPGD_STORE is d1 but DB binding is not configured.');
    }
    return createD1NotificationStore(accountingDatabase(env.DB));
  }
  let store = memoryStoresByEnv.get(env);
  if (store === undefined) {
    console.warn(
      'Notifications use the memory store: consent records and endpoints live only in this isolate. Use D1 outside local development.',
    );
    store = accountingStore(createInMemoryNotificationStore());
    memoryStoresByEnv.set(env, store);
  }
  return store;
}

/** A JSON var as wrangler passes it: already an object, or JSON text. */
function parseJsonVar(value: unknown, name: string): unknown {
  if (value === undefined || typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} is not JSON.`);
  }
}

/**
 * Serves the notifications routes, or `undefined` for any other path.
 *
 * - `GET /providers`: the registry entries and served targets (public).
 * - With a session (the `GAME_SERVICES_NOTIFICATIONS_AUTH` binding): `GET` and
 *   `POST /consent`, `POST /endpoints`, `POST /endpoints/unregister`,
 *   `GET /notices`, `POST /notices/shown`, `POST /reminders` (`{ reminder }`,
 *   answers `{ status }`), and `POST /reminders/cancel` (`{ key }`, answers
 *   `{ cancelled }`). Without the binding they are not
 *   mounted (404): binding a device to a player needs an authenticated
 *   session. A Worker with a catalog but no binding logs that once, when a
 *   session route is first asked for.
 *
 * Sends are never a client route; a game server sends through the
 * `deliverNotification` RPC on the service binding.
 */
export function createNotificationsFetchHandler(
  env: GameServicesNotificationsEnv,
  corsHeaders: Readonly<Record<string, string>>,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== notificationsRoutePrefix && !pathname.startsWith(`${notificationsRoutePrefix}/`)) {
      return undefined;
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const notifications = resolveWorkerNotifications(env);
    if (notifications.status === 'disabled') {
      return json({ error: 'UNKNOWN_ENDPOINT' }, 404, corsHeaders);
    }
    if (notifications.status === 'misconfigured') {
      return json({ error: 'INTERNAL_ERROR' }, 500, corsHeaders);
    }
    const { service } = notifications;
    const route = pathname.slice(notificationsRoutePrefix.length);
    const method = request.method;
    if (route === '/providers') {
      return method === 'GET'
        ? json(
            { protocolVersion: notificationsProtocolVersion, ...service.providers() },
            200,
            corsHeaders,
          )
        : json({ error: 'METHOD_NOT_ALLOWED' }, 405, corsHeaders);
    }
    const allowed: Readonly<Record<string, readonly string[]>> = {
      '/consent': ['GET', 'POST'],
      '/endpoints': ['POST'],
      '/endpoints/unregister': ['POST'],
      '/notices': ['GET'],
      '/notices/shown': ['POST'],
      '/reminders': ['POST'],
      '/reminders/cancel': ['POST'],
    };
    const methods = allowed[route];
    const auth = env.GAME_SERVICES_NOTIFICATIONS_AUTH;
    if (methods !== undefined && auth === undefined && !reportedMissingSessionBinding.has(env)) {
      // Said when a session route is first asked for, never from the cron or
      // the queue: a send-only Worker (deliverNotification alone) needs no
      // session binding.
      reportedMissingSessionBinding.add(env);
      console.warn(
        'Notifications: MPGD_NOTIFICATIONS_CATALOG is set but the GAME_SERVICES_NOTIFICATIONS_AUTH binding is not; '
          + 'the client session routes (consent, endpoints, notices, reminders) are off and answer 404. '
          + 'A send-only Worker can ignore this.',
      );
    }
    if (methods === undefined || auth === undefined) {
      return json({ error: 'UNKNOWN_ENDPOINT' }, 404, corsHeaders);
    }
    if (!methods.includes(method)) {
      return json({ error: 'METHOD_NOT_ALLOWED' }, 405, corsHeaders);
    }
    // Per-player answers are never cached; a client may read Retry-After.
    const privateHeaders = {
      ...corsHeaders,
      'Cache-Control': 'no-store',
      'Access-Control-Expose-Headers': 'Retry-After',
    };
    const session = await authenticate(request, auth);
    if (session instanceof Response) {
      return withHeaders(session, privateHeaders);
    }
    let body: Readonly<Record<string, unknown>> = {};
    if (method === 'POST') {
      let parsed: Awaited<ReturnType<typeof readBody>>;
      try {
        parsed = await readBody(request);
      } catch (error) {
        // The body could not be read (the client went away, the stream broke).
        console.warn('Notifications request body could not be read:', errorName(error));
        parsed = undefined;
      }
      if (parsed === 'too-large') {
        return json({ error: 'PAYLOAD_TOO_LARGE' }, 413, privateHeaders);
      }
      if (parsed === undefined) {
        return json({ error: 'BAD_REQUEST' }, 400, privateHeaders);
      }
      body = parsed;
    }
    // Fields go to the service as sent: it validates each at run time, so a
    // wrong type is a 400 and never becomes another request. The casts below
    // only satisfy the service's declared types; they are not checks.
    try {
      switch (`${method} ${route}`) {
        case 'GET /consent':
          return json({ records: await service.listConsent(session) }, 200, privateHeaders);
        case 'POST /consent':
          return json(
            { record: await service.recordConsent(session, body.record) },
            200,
            privateHeaders,
          );
        case 'POST /endpoints': {
          const retryAfterSeconds = endpointWriteRetryAfter(session.sessionId);
          if (retryAfterSeconds !== undefined) {
            return json(
              {
                error: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
                message: `Too many endpoint registrations today; retry in ${retryAfterSeconds} s.`,
              },
              429,
              { ...privateHeaders, 'Retry-After': String(retryAfterSeconds) },
            );
          }
          await service.registerEndpoint(session, {
            registration: body.registration,
            ...(body.target === undefined ? {} : { target: body.target as string }),
          });
          return json({}, 200, privateHeaders);
        }
        case 'POST /endpoints/unregister':
          await service.unregisterEndpoint(
            session,
            body.provider === undefined ? {} : { provider: body.provider as string },
          );
          return json({}, 200, privateHeaders);
        case 'GET /notices':
          return json({ notices: await service.listNotices(session) }, 200, privateHeaders);
        case 'POST /notices/shown':
          await service.recordNoticeShown(
            session,
            body.notice,
            body.channel === undefined ? {} : { channel: body.channel as 'in-game' },
          );
          return json({}, 200, privateHeaders);
        case 'POST /reminders':
          return json(await service.setReminder(session, body.reminder), 200, privateHeaders);
        case 'POST /reminders/cancel':
          return json(
            await service.cancelReminder(session, { key: body.key }),
            200,
            privateHeaders,
          );
        default:
          return json({ error: 'UNKNOWN_ENDPOINT' }, 404, privateHeaders);
      }
    } catch (error) {
      return errorResponse(error, privateHeaders);
    }
  };
}

/** The send a game server makes through the service binding. */
export async function deliverWorkerNotification(env: GameServicesNotificationsEnv, input: unknown): Promise<unknown> {
  return readyService(env).deliver(input);
}

/**
 * A service-binding answer that keeps a notifications error's code across
 * the RPC boundary, which carries an error's message but not its fields.
 */
export type WorkerNotificationRpcResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
    };

export async function asWorkerNotificationRpcResult<Value>(
  work: () => Promise<Value>,
): Promise<WorkerNotificationRpcResult<Value>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof NotificationError) {
      return {
        ok: false,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      };
    }
    throw error;
  }
}

/** Ends a session's bindings: the identity Worker calls it on logout, revocation, or expiry. */
export async function endWorkerNotificationSession(
  env: GameServicesNotificationsEnv,
  input: { readonly sessionId: string },
): Promise<void> {
  await readyService(env).endSession(input);
}

/**
 * The dispatch queue's consumer: each message is one recipient's delivery.
 * A failure that may pass is retried with a growing delay; a job that cannot
 * run as asked is logged and acknowledged, and its row stays due for the
 * cron. A misconfigured Worker (a bad deploy) retries every message with the
 * same backoff, so the jobs survive until the configuration is fixed or the
 * dead-letter queue takes them; a Worker without a catalog has notifications
 * off, and acknowledges them. Either is logged once.
 */
export async function consumeNotificationDispatchBatch(
  env: GameServicesNotificationsEnv,
  batch: MessageBatch<unknown>,
): Promise<void> {
  const notifications = resolveWorkerNotifications(env);
  const backoff = (attempts: number) => ({
    delaySeconds: Math.min(2 ** Math.max(attempts, 1) * 5, 300),
  });
  if (notifications.status !== 'ready' && !reportedUnreadyConsumer.has(env)) {
    reportedUnreadyConsumer.add(env);
    console.error(
      notifications.status === 'disabled'
        ? 'Notifications dispatch jobs arrived but this Worker has no MPGD_NOTIFICATIONS_CATALOG; they are acknowledged.'
        : 'Notifications dispatch jobs are retried until the notifications configuration is fixed.',
    );
  }
  // Deliveries are independent: one slow provider call does not hold up the others.
  await Promise.all(
    batch.messages.map(async (message) => {
      if (notifications.status === 'disabled') {
        message.ack();
        return;
      }
      if (notifications.status === 'misconfigured') {
        message.retry(backoff(message.attempts));
        return;
      }
      try {
        await notifications.service.dispatch(message.body as NotificationDispatchJob);
        message.ack();
      } catch (error) {
        if (error instanceof NotificationError && !error.retryable) {
          console.error('Notifications dispatch failed:', describeFailure(error));
          message.ack();
        } else {
          message.retry(backoff(message.attempts));
        }
      }
    }),
  );
}

/**
 * The cron: retention purges, then one scheduler run (due server reminders
 * and consent notice checks, then due rows: deferred sends and expired
 * leases, paced by each provider's rate and sent through the queue when one
 * is bound), each step on its own so a failed purge never skips the
 * scheduler. Rounds of MPGD_NOTIFICATIONS_DUE_BATCH continue until nothing
 * is due, the wall budget is used, or another round would cross
 * MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET. That count belongs to this
 * invocation: a fetch, queue, or RPC event on the same isolate is not
 * charged and cannot be stopped by it. A wall budget that is not shorter
 * than the cron period is rejected so the next trigger does not overlap
 * this run. Purge is counted before the first round; a round is not started
 * when what remains cannot cover it.
 */
export async function runScheduledNotifications(
  env: GameServicesNotificationsEnv,
  trigger?: { readonly cron?: string },
): Promise<void> {
  const notifications = resolveWorkerNotifications(env);
  if (notifications.status !== 'ready') {
    return;
  }
  const periodSeconds = notificationCronPeriodSeconds(trigger?.cron ?? '* * * * *');
  const budgetSeconds = cronWallBudgetSeconds(env, periodSeconds);
  const budget: NotificationCronBudget = {
    remaining: subrequestBudgetOf(env),
    used: 0,
    roundReserve: 0,
  };
  try {
    await cronInvocation.run(budget, async () => {
      try {
        await notifications.service.purge();
      } catch (error) {
        console.error('Notifications purge failed:', describeFailure(error));
      }
      if (budgetSeconds === undefined) {
        return;
      }
      const limit = dueBatchOf(env, budget.remaining);
      budget.roundReserve = limit * estimatedOperationsPerDueItem;
      // The service always runs one round before it checks elapsed time, so
      // a round that cannot finish is not started.
      if (limit < 1 || budget.remaining < budget.roundReserve) {
        return;
      }
      try {
        const { failed } = await notifications.service.runScheduler({
          limit,
          budgetMs: budgetSeconds * 1000,
        });
        if (failed > 0) {
          console.error('Notifications scheduler:', failed, 'item(s) failed; see the reports above.');
        }
      } catch (error) {
        console.error('Notifications scheduler failed:', describeFailure(error));
      }
    });
  } finally {
    lastCronOperations.set(env, budget.used);
  }
}

/** Operations the last finished cron run on this env counted, for tests and logs. */
export function notificationCronOperationsUsed(env: object): number {
  return lastCronOperations.get(env) ?? 0;
}

/**
 * Subrequests one paid-plan cron run may spend before it stops. Workers Paid
 * allows 10,000 per invocation as of 2026-02-11 (1,000 before that). 1,000
 * fits either cap and leaves headroom for the purge. The free plan allows 50
 * external subrequests and 10 ms of CPU: this cron is not for that plan.
 */
export const defaultNotificationCronSubrequestBudget = 1_000;
/**
 * Store or D1 calls assumed for one due item, plus the most fetches one FCM
 * send can make (a cold token grant, the send, a bare 401, and the retried
 * grant and send). Actual calls are counted; this reserve only stops a
 * round that would not fit in what remains.
 */
const estimatedStoreOperationsPerDueItem = 12;
const maxProviderFetchesPerSend = 4;
const estimatedOperationsPerDueItem = estimatedStoreOperationsPerDueItem + maxProviderFetchesPerSend;
const defaultCronWallBudgetSeconds = 20;
const endpointWriteWindowMs = 86_400_000;

interface NotificationCronBudget {
  remaining: number;
  used: number;
  roundReserve: number;
}

/** The scheduled invocation's budget. Absent on fetch, queue, and RPC events. */
const cronInvocation = new AsyncLocalStorage<NotificationCronBudget>();
/** The last finished run's count, for tests and logs. Not the live counter. */
const lastCronOperations = new WeakMap<object, number>();
const endpointWritesBySession = new Map<string, number[]>();

class NotificationCronBudgetExhausted extends Error {
  override readonly name = 'NotificationCronBudgetExhausted';

  constructor() {
    super('Notifications cron subrequest budget is exhausted; this run stops.');
  }
}

function takeCronOperation(count = 1): void {
  const budget = cronInvocation.getStore();
  if (budget === undefined) {
    return;
  }
  if (budget.remaining < count) {
    throw new NotificationCronBudgetExhausted();
  }
  budget.remaining -= count;
  budget.used += count;
}

/**
 * Counts one provider fetch against the scheduled invocation, then calls
 * through. Outside a cron there is nothing to charge.
 */
function countingFetch(
  inner: (input: string, init?: RequestInit) => Promise<Response>,
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    takeCronOperation();
    return inner(input, init);
  };
}

function countingMtls(
  mtls: NonNullable<GameServicesNotificationsEnv['AIT_PARTNER_MTLS']>,
): NonNullable<GameServicesNotificationsEnv['AIT_PARTNER_MTLS']> {
  return {
    fetch(input, init) {
      takeCronOperation();
      return mtls.fetch(input, init);
    },
  };
}

function notificationCronElapsed(): number {
  const budget = cronInvocation.getStore();
  if (budget === undefined || budget.remaining >= budget.roundReserve) {
    return performance.now();
  }
  // The service checks this only between rounds, so a round that would not fit is not started.
  return Number.POSITIVE_INFINITY;
}

function subrequestBudgetOf(env: GameServicesNotificationsEnv): number {
  const declared = env.MPGD_NOTIFICATIONS_SUBREQUEST_BUDGET?.trim();
  const asked = declared === undefined || declared === ''
    ? defaultNotificationCronSubrequestBudget
    : Number(declared);
  return Number.isFinite(asked) && asked >= 1
    ? Math.floor(asked)
    : defaultNotificationCronSubrequestBudget;
}

function dueBatchOf(env: GameServicesNotificationsEnv, operationBudget: number): number {
  const declared = env.MPGD_NOTIFICATIONS_DUE_BATCH?.trim();
  const asked = declared === undefined || declared === '' ? 25 : Number(declared);
  const clamped = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), 100) : 25;
  const affordable = Math.floor(operationBudget / estimatedOperationsPerDueItem);
  return affordable < 1 ? 0 : Math.min(clamped, affordable);
}

function cronWallBudgetSeconds(
  env: GameServicesNotificationsEnv,
  periodSeconds: number,
): number | undefined {
  const declared = env.MPGD_NOTIFICATIONS_CRON_BUDGET_SECONDS?.trim();
  const asked = declared === undefined || declared === ''
    ? defaultCronWallBudgetSeconds
    : Number(declared);
  const seconds = Number.isFinite(asked) && asked >= 1
    ? Math.floor(asked)
    : defaultCronWallBudgetSeconds;
  if (seconds >= periodSeconds) {
    console.error(
      'Notifications cron budget of '
        + `${seconds}s is not shorter than the cron period of ${periodSeconds}s; `
        + 'the scheduler is skipped so runs do not overlap.',
    );
    return undefined;
  }
  return seconds;
}

/**
 * Minimum seconds between firings of a 5-field cron, from its minute and
 * hour fields. An expression this cannot parse is treated as every minute,
 * the strictest period the documented trigger uses.
 */
export function notificationCronPeriodSeconds(cron: string): number {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return 60;
  }
  const minutes = expandCronField(fields[0] ?? '', 0, 59);
  const hours = expandCronField(fields[1] ?? '', 0, 23);
  if (minutes === undefined || hours === undefined) {
    return 60;
  }
  const slots: number[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      slots.push(hour * 60 + minute);
    }
  }
  slots.sort((left, right) => left - right);
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (first === undefined || last === undefined) {
    return 60;
  }
  let gap = first + 24 * 60 - last;
  for (let index = 1; index < slots.length; index += 1) {
    gap = Math.min(gap, (slots[index] ?? 0) - (slots[index - 1] ?? 0));
  }
  return Math.max(gap, 1) * 60;
}

function expandCronField(field: string, min: number, max: number): readonly number[] | undefined {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/u.exec(part);
    if (match === null) {
      return undefined;
    }
    const [, star, startText, endText, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      return undefined;
    }
    const start = star === '*' ? min : Number(startText);
    // Quartz increment: `5/15` starts at 5 and steps through the field end.
    const end = endText !== undefined
      ? Number(endText)
      : star === '*' || stepText !== undefined
        ? max
        : start;
    if (start < min || end > max || start > end) {
      return undefined;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values.size === 0 ? undefined : [...values].sort((left, right) => left - right);
}

function accountingStore(store: NotificationStore): NotificationStore {
  const wrapped: Partial<Record<keyof NotificationStore, unknown>> = {};
  for (const key of Object.keys(store) as (keyof NotificationStore)[]) {
    const method = store[key];
    if (typeof method !== 'function') {
      continue;
    }
    wrapped[key] = (...args: unknown[]) => {
      takeCronOperation();
      return (method as (...inner: unknown[]) => unknown).apply(store, args);
    };
  }
  return wrapped as NotificationStore;
}

function accountingDatabase(db: D1Database): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const call = <Result>(method: (...args: never[]) => Result, values: unknown[]): Result =>
      method.apply(statement, values as never[]);
    const wrapped = {
      bind(...values: unknown[]) {
        return wrap(call(statement.bind, values));
      },
      run(...values: unknown[]) {
        takeCronOperation();
        return call(statement.run, values);
      },
      all(...values: unknown[]) {
        takeCronOperation();
        return call(statement.all, values);
      },
      first(...values: unknown[]) {
        takeCronOperation();
        return call(statement.first, values);
      },
      raw(...values: unknown[]) {
        takeCronOperation();
        return call(statement.raw, values);
      },
    };
    originals.set(wrapped, statement);
    return wrapped as D1PreparedStatement;
  };
  return {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch(statements: D1PreparedStatement[]) {
      takeCronOperation();
      return db.batch(statements.map((statement) => originals.get(statement) ?? statement));
    },
    dump: () => db.dump(),
    exec(query: string) {
      takeCronOperation();
      return db.exec(query);
    },
  } as D1Database;
}

/**
 * Writes of POST /endpoints one session may make per rolling day, the same
 * cap as client consent records. Counted in this isolate: it stops a guest
 * session looping on one isolate, and a repeat still costs a D1 upsert.
 * Answers when to retry, in seconds, once the cap is full.
 */
function endpointWriteRetryAfter(sessionId: string, now = Date.now()): number | undefined {
  const windowStart = now - endpointWriteWindowMs;
  const recent = (endpointWritesBySession.get(sessionId) ?? []).filter((at) => at > windowStart);
  if (recent.length >= maxClientNotificationConsentRecordsPerDay) {
    endpointWritesBySession.set(sessionId, recent);
    const oldest = recent[0] ?? now;
    return Math.max(1, Math.ceil((oldest + endpointWriteWindowMs - now) / 1000));
  }
  recent.push(now);
  endpointWritesBySession.set(sessionId, recent);
  if (endpointWritesBySession.size > 10_000) {
    const oldestSession = endpointWritesBySession.keys().next().value;
    if (oldestSession !== undefined) {
      endpointWritesBySession.delete(oldestSession);
    }
  }
  return undefined;
}

function readyService(env: GameServicesNotificationsEnv): NotificationService {
  const notifications = resolveWorkerNotifications(env);
  if (notifications.status === 'ready') {
    return notifications.service;
  }
  throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
    message: notifications.status === 'disabled'
      ? 'This Worker has no notification catalog.'
      : 'This Worker’s notifications are misconfigured.',
  });
}

async function authenticate(
  request: Request,
  auth: GameServicesNotificationsAuthBinding,
): Promise<NotificationSession | Response> {
  const authorization = request.headers.get('Authorization');
  if (authorization === null || authorization.length === 0) {
    return json({ error: 'UNAUTHORIZED' }, 401, {});
  }
  let principal: unknown;
  try {
    principal = await auth.authenticateNotificationSession({ authorization });
  } catch (error) {
    console.error('Notifications session binding failed:', errorName(error));
    return json({ error: 'AUTHENTICATION_FAILED' }, 500, {});
  }
  if (principal === undefined || principal === null) {
    return json({ error: 'UNAUTHORIZED' }, 401, {});
  }
  const record = typeof principal === 'object' && !Array.isArray(principal)
    ? principal as Readonly<Record<string, unknown>>
    : {};
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (
    !text(record.playerId)
    || !text(record.sessionId)
    || !text(record.installationId)
    || (record.expiresAt !== undefined
      && !(text(record.expiresAt) && record.expiresAt.length <= 64 && isNotificationTimestamp(record.expiresAt)))
  ) {
    console.error('Notifications session binding answered no valid session.');
    return json({ error: 'AUTHENTICATION_FAILED' }, 500, {});
  }
  if (typeof record.expiresAt === 'string' && Date.parse(record.expiresAt) <= Date.now()) {
    // A session that already ended writes nothing more.
    return json({ error: 'UNAUTHORIZED' }, 401, {});
  }
  return {
    player: record.playerId,
    sessionId: record.sessionId,
    installationId: record.installationId,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt as string }),
  };
}

/** The JSON object body, read as a stream that stops at the size limit. */
async function readBody(
  request: Request,
): Promise<Readonly<Record<string, unknown>> | 'too-large' | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    return 'too-large';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined;
  } catch {
    return undefined;
  }
}

function errorResponse(error: unknown, corsHeaders: Readonly<Record<string, string>>): Response {
  if (error instanceof NotificationError) {
    // A player's own write cap is a throttle, not an outage, and says when it lifts.
    const throttled = error instanceof NotificationConsentRateLimitError;
    const status = throttled ? 429 : statusOf(error.code);
    const retryAfterSeconds = throttled ? error.retryAfterSeconds : 5;
    return json(
      { error: error.code, ...(status < 500 ? { message: error.message } : {}) },
      status,
      error.retryable ? { ...corsHeaders, 'Retry-After': String(retryAfterSeconds) } : corsHeaders,
    );
  }
  console.error('Notifications route failed:', describeFailure(error));
  return json({ error: 'INTERNAL_ERROR' }, 500, corsHeaders);
}

function statusOf(code: NotificationError['code']): number {
  switch (code) {
    case 'NOTIFICATIONS_INVALID_INPUT':
      return 400;
    case 'NOTIFICATIONS_IDEMPOTENCY_CONFLICT':
      return 409;
    case 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

function errorName(error: unknown): string {
  if (error instanceof NotificationError) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'Error';
}

/**
 * A failure for the logs: its code or name and the start of its message.
 * The kit's own messages carry no token or key; a store or parser message
 * may quote stored text, so it is cut to 120 characters.
 */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const characters = Array.from(message);
  return `${errorName(error)}: ${characters.length > 120 ? `${characters.slice(0, 120).join('')}…` : message}`;
}

function json(body: unknown, status: number, headers: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: merged });
}
