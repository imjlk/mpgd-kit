import {
  createFcmProviderRegistration,
  createInMemoryNotificationStore,
  createNotificationProviderRegistry,
  createNotificationService,
  createNotificationServiceCatalog,
  NotificationConsentRateLimitError,
  parseFcmServiceAccount,
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
 * server sends through, the dispatch queue consumer, and the scheduled purge
 * and due-row replay.
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
  /** Sends the cron replays per run; 25 by default, at most 100 (each send costs several subrequests). */
  readonly MPGD_NOTIFICATIONS_DUE_BATCH?: string;
}

export type WorkerNotifications =
  | { readonly status: 'disabled' }
  | { readonly status: 'ready'; readonly service: NotificationService }
  | { readonly status: 'misconfigured'; readonly error: Error };

export const notificationsRoutePrefix = '/game-services/notifications';
/** Largest request body a notifications route reads. */
const maxBodyBytes = 64 * 1024;

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
    const provider = createAitFunctionalMessageDeliveryProvider({
      ...aitProviderSettings(aitSettings),
      mtls: env.AIT_PARTNER_MTLS,
    });
    providers.push({ entry: provider.entry, delivery: provider, targets: ['ait'] });
  }
  return providers;
}

/** `MPGD_AIT_NOTIFICATIONS`, checked field by field: a typo fails at startup, not at the first send. */
function aitProviderSettings(value: unknown): Omit<CreateAitFunctionalMessageDeliveryProviderOptions, 'mtls'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MPGD_AIT_NOTIFICATIONS is an object.');
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
    throw new Error(`MPGD_AIT_NOTIFICATIONS has no field ${unknownField}.`);
  }
  const { recipientKey, baseUrl, timeoutMs } = settings;
  if (recipientKey !== 'toss-user' && recipientKey !== 'anonymous') {
    throw new Error("MPGD_AIT_NOTIFICATIONS.recipientKey is 'toss-user' or 'anonymous'.");
  }
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new Error('MPGD_AIT_NOTIFICATIONS.baseUrl is a string.');
  }
  if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
    throw new Error('MPGD_AIT_NOTIFICATIONS.timeoutMs is a number.');
  }
  const codes = (name: string): readonly string[] | undefined => {
    const list = settings[name];
    if (list === undefined) {
      return undefined;
    }
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
      throw new Error(`MPGD_AIT_NOTIFICATIONS.${name} is a list of strings.`);
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
          resolvePlatformRecipient: async ({ provider, player }) =>
            (await identity.resolveNotificationRecipient({ provider, playerId: player })) ?? undefined,
        }),
    ...(queue === undefined
      ? {}
      : {
          queue: {
            async enqueue(jobs) {
              // A queue batch carries at most 100 messages.
              for (let start = 0; start < jobs.length; start += 100) {
                await queue.sendBatch(jobs.slice(start, start + 100).map((body) => ({ body })));
              }
            },
          },
        }),
    onError(error, context) {
      // Operation and keys only: an error never carries a token or a key here.
      console.error('Notifications:', context.operation, context.sendKey ?? '', context.provider ?? '', errorName(error));
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
    return createD1NotificationStore(env.DB);
  }
  let store = memoryStoresByEnv.get(env);
  if (store === undefined) {
    console.warn(
      'Notifications use the memory store: consent records and endpoints live only in this isolate. Use D1 outside local development.',
    );
    store = createInMemoryNotificationStore();
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
 *   `GET /notices`, `POST /notices/shown`. Without the binding they are not
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
          + 'the client session routes (consent, endpoints, notices) are off and answer 404. '
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
        case 'POST /endpoints':
          await service.registerEndpoint(session, {
            registration: body.registration,
            ...(body.target === undefined ? {} : { target: body.target as string }),
          });
          return json({}, 200, privateHeaders);
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
 * The cron: retention purges, then a batch of due rows (deferred sends,
 * expired leases), each step on its own so a failed purge never skips the
 * replays. The batch is small because each send costs several subrequests.
 */
export async function runScheduledNotifications(env: GameServicesNotificationsEnv): Promise<void> {
  const notifications = resolveWorkerNotifications(env);
  if (notifications.status !== 'ready') {
    return;
  }
  const declared = env.MPGD_NOTIFICATIONS_DUE_BATCH?.trim();
  const asked = declared === undefined || declared === '' ? 25 : Number(declared);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), 100) : 25;
  try {
    await notifications.service.purge();
  } catch (error) {
    console.error('Notifications purge failed:', describeFailure(error));
  }
  try {
    const { failed } = await notifications.service.dispatchDue({ limit });
    if (failed > 0) {
      console.error('Notifications due replay:', failed, 'send(s) failed and stay due.');
    }
  } catch (error) {
    console.error('Notifications due replay failed:', describeFailure(error));
  }
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
