import {
  createNotificationProviderRegistry,
  createNotificationService,
  createNotificationServiceCatalog,
  type CreateNotificationServiceInput,
  type NotificationProviderRegistry,
  type NotificationRemoteDeliveryAnswer,
  type NotificationRemoteDeliveryProvider,
  type NotificationService,
  type NotificationServiceCatalog,
  type NotificationSession,
  type NotificationStore,
} from '@mpgd/game-services/notifications';
import {
  referenceNotificationProviders,
  type NotificationDeployment,
  type NotificationPermissionState,
  type NotificationProviderRegistryEntry,
} from '@mpgd/platform/notifications';

import {
  devvitNotificationBodyMaxLength,
  devvitNotificationLinkPattern,
  devvitNotificationProviderId,
  devvitNotificationsPerAppPerDay,
  devvitNotificationsPerUserPerDay,
  devvitNotificationTarget,
  devvitNotificationTextLength,
  devvitNotificationTitleMaxLength,
  devvitUserIdPattern,
} from '../notifications-contract.js';
import {
  createDevvitRedisNotificationStore,
  type CreateDevvitRedisNotificationStoreOptions,
  type DevvitNotificationRedis,
} from './redis-notification-store.js';

/**
 * Remote delivery on Devvit (notifications v2 RFC, "Delivery providers",
 * Devvit). It runs inside the Devvit server, not the game-services Worker,
 * because only that runtime can call the notifications plugin: the same
 * `@mpgd/game-services/notifications` service, policy gate, and delivery
 * module, over a Redis-backed store.
 *
 * `enqueue` and `isOptedIn` are `notifications` from `@devvit/web/server`
 * (`@devvit/notifications` 0.14.1): <https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/notifications/pn-best-practices>.
 */

/** One recipient of `notifications.enqueue` (`EnqueueOptions['recipients'][number]`). */
export interface DevvitEnqueueRecipient {
  readonly userId: `t2_${string}`;
  readonly link: `t1_${string}` | `t3_${string}`;
  readonly data: Record<string, string>;
}

/** What `notifications.enqueue` answers (`EnqueueResponse`). */
export interface DevvitEnqueueResponse {
  readonly successCount: number;
  readonly failureCount: number;
  readonly errors: readonly { readonly userId: string | undefined; readonly message: string }[];
}

/** The server side of the Devvit notifications plugin that sends and reads opt-in. */
export interface DevvitNotificationsDeliveryClient {
  enqueue(options: {
    title: string;
    body: string;
    recipients: DevvitEnqueueRecipient[];
  }): Promise<DevvitEnqueueResponse>;
  isOptedIn(userId: `t2_${string}`): Promise<boolean>;
}

/**
 * How an `enqueue` failure is answered: a per-recipient error of the answer
 * (`source: 'answer'`: Devvit counted a failure for the user, but an error
 * the defaults cannot read is still `ambiguous`) or a call that threw
 * (`source: 'thrown'`, Devvit may have queued it, so `ambiguous` is the
 * default and the only safe answer unless the error proves nothing was
 * sent: a classifier must answer `undefined` or `ambiguous` for a thrown
 * error it does not know). An answer that counts neither a success nor a
 * failure is not classified. Devvit documents no error messages (checked
 * 2026-10-19); a deployment that observes one (through `onEnqueueError`)
 * names it here. `undefined` keeps the default.
 */
export type DevvitEnqueueErrorClassifier = (
  message: string,
  source: 'answer' | 'thrown',
) => 'rate-limited' | 'recipient' | 'configuration' | 'ambiguous' | undefined;

/** An `enqueue` failure, for the operator's log; the message is Devvit's and may name the user. */
export interface DevvitEnqueueErrorReport {
  readonly sendKey: string;
  readonly source: 'answer' | 'thrown';
  readonly message: string;
  readonly answer: NotificationRemoteDeliveryAnswer['status'];
  /** The reason of a `rejected` answer. */
  readonly reason?: 'configuration' | 'recipient';
}

export interface CreateDevvitNotificationDeliveryProviderInput {
  readonly notifications: DevvitNotificationsDeliveryClient;
  /**
   * The Reddit user id of a player, for the send-time opt-in read. By
   * default a player id that is a `t2_` id (the Devvit server bridge's
   * `context.userId`) is its own Reddit id.
   */
  readonly userIdOf?: (player: string) => string | undefined;
  readonly classifyEnqueueError?: DevvitEnqueueErrorClassifier;
  /**
   * Every `enqueue` failure and how it was answered, so an operator learns
   * Devvit's messages. `createDevvitNotificationService` forwards the
   * `ambiguous` ones and the `configuration` rejections to `onError`.
   */
  readonly onEnqueueError?: (report: DevvitEnqueueErrorReport) => void;
}

/** Provider codes of the answers this provider gives without calling `enqueue`. */
export const devvitNotificationProviderCodes = Object.freeze({
  deviceRecipient: 'DEVVIT_DEVICE_RECIPIENT',
  recipientInvalid: 'DEVVIT_RECIPIENT_INVALID',
  linkInvalid: 'DEVVIT_LINK_INVALID',
  textMissing: 'DEVVIT_TEXT_MISSING',
  titleTooLong: 'DEVVIT_TITLE_TOO_LONG',
  bodyTooLong: 'DEVVIT_BODY_TOO_LONG',
  templateSyntax: 'DEVVIT_TEMPLATE_SYNTAX',
  enqueueFailed: 'DEVVIT_ENQUEUE_FAILED',
  enqueueRejected: 'DEVVIT_ENQUEUE_REJECTED',
  enqueueUnanswered: 'DEVVIT_ENQUEUE_UNANSWERED',
  enqueueUnclassified: 'DEVVIT_ENQUEUE_UNCLASSIFIED',
} as const);

/**
 * Whether a message reads as a rate limit: per user (2 a day) or per app
 * (25,000 a day). A limit counts only next to a word about sending and
 * never next to one about the text, so "character limit exceeded" stays a
 * configuration refusal.
 */
function readsAsRateLimit(message: string): boolean {
  if (/rate[ -]?limit|too many (?:requests|notifications)|quota|throttl/iu.test(message)) {
    return true;
  }
  // A word about size or about the text marks a length or content refusal,
  // whatever period it names. "Message" may count sends ("daily message
  // limit"), so it marks one only when the message names no period.
  if (/\b(?:characters?|length|long|size|bytes?|title|body|link|text|content|payload|template)\b/iu.test(
    message,
  )) {
    return false;
  }
  if (!dailyLimitWords.test(message) && /\bmessages?\b/iu.test(message)) {
    return false;
  }
  // "Daily send limit", "per-user limits": the limit names what it counts.
  if (adjacentCountedLimit.test(message)) {
    return true;
  }
  return /\blimits?\b/iu.test(message)
    && /\b(?:exceed(?:s|ed)?|reach(?:es|ed)?|hit)\b/iu.test(message)
    && (dailyLimitWords.test(message) || /\b(?:notifications?|user|app|send(?:s|ing)?)\b/iu.test(message));
}

/** The words that name a daily period, once: Devvit's limits are per user per day and per app per day. */
const dailyPeriodSource = String.raw`daily|per[- ]?(?:day|user|app)|today'?s?`;
const dailyLimitWords = new RegExp(String.raw`\b(?:${dailyPeriodSource})\b`, 'iu');
const adjacentCountedLimit = new RegExp(
  String.raw`\b(?:${dailyPeriodSource}|send(?:ing)?|notifications?) limits?\b`,
  'iu',
);

/**
 * A message that reads as this user's refusal: not opted in, opted out, no
 * such user or account. It counts only for an error that names this
 * recipient.
 */
function readsAsUserRefusal(message: string): boolean {
  // A message about the link, the post, or the comment is not the user's.
  if (/\b(?:perma)?(?:link|post|comment)(?:s|_?ids?)?\b|\bt[13]_/iu.test(message)) {
    return false;
  }
  return /\bopt(?:ed|ing)?[ -]?(?:in|out)\b|\bnot subscribed\b|\bnotifications? (?:are )?disabled\b/iu.test(message)
    || /\b(?:user|account|recipient)(?:\s+(?:with\s+)?(?:id\s+)?t2_\w+)?\s+(?:is\s+|was\s+|has\s+been\s+)?(?:not found|does not exist|deleted|suspended|banned)\b/iu
      .test(message);
}

/** The reason a report names: only the two reasons this provider answers. */
function reasonOf(answer: NotificationRemoteDeliveryAnswer): Pick<DevvitEnqueueErrorReport, 'reason'> {
  if (answer.status !== 'rejected') {
    return {};
  }
  if (answer.reason === 'recipient' || answer.reason === 'configuration') {
    return { reason: answer.reason };
  }
  return {};
}

/**
 * The Devvit delivery provider (`{ id: 'devvit', send, readPermission }`).
 * One recipient per `enqueue` call in the first wave (RFC "Open questions",
 * bulk sends).
 *
 * - **What it sends.** The gate's title and body as they are, with the
 *   send's `link` (else the mapping's) and no template data. Every Mustache
 *   tag starts with `{{`, so a filled text that still holds one (from
 *   template data such as a player name, or a catalog brace outside a
 *   `{{name}}` placeholder) is refused (`rejected`, `configuration`, provider
 *   code `DEVVIT_TEMPLATE_SYNTAX`) before anything is sent.
 * - **Limits it checks first.** A missing or blank title or body, a title over 60 or a body over 100 code
 *   points of the filled text (see `devvitNotificationTextLength`), a link
 *   that is not a `t3_` or `t1_` id, and a recipient that is not a `t2_` id
 *   are `rejected` with reason `configuration` (the recipient: `recipient`),
 *   because the same send would fail again.
 * - **Answers.** `successCount` above 0 is `accepted`. Otherwise an error for
 *   this recipient (or for no named user) is a failure Devvit counted:
 *   a message that reads as a rate limit is `rate-limited` (deferred, for
 *   at most a day), one that reads as the user's refusal (not opted in, no
 *   such user) in an error that names this recipient is `rejected` with
 *   reason `recipient`. Any other error is `ambiguous` (provider code
 *   `DEVVIT_ENQUEUE_UNCLASSIFIED`): Devvit documents no error messages, so
 *   an unknown one is neither proof of a setup error nor of a refusal. The
 *   service reports it to the operator and replays it after each lease,
 *   which doubles from the claim lease up to an hour, for at most 24 hours
 *   after the first attempt (`notificationAmbiguousReplayHours`): with the
 *   default 300-second lease, at most 26 calls. A call that throws,
 *   or an answer that counts neither a success nor a failure, is
 *   `ambiguous` too: Devvit may have queued it, and `enqueue` takes no
 *   idempotency key, so a replay may show twice.
 *   `classifyEnqueueError` overrides each default, and `onEnqueueError`
 *   sees every failure with Devvit's message.
 * - **Opt-in at send time.** `readPermission` reads `isOptedIn`, since no
 *   opt-out event exists and opt-out may move into Reddit settings: opted in
 *   is `granted`, otherwise `prompt`.
 */
export function createDevvitNotificationDeliveryProvider(
  input: CreateDevvitNotificationDeliveryProviderInput,
): NotificationRemoteDeliveryProvider {
  const userIdOf = input.userIdOf ?? ((player: string) => player);
  const rejected = (
    reason: 'configuration' | 'recipient',
    providerCode: string,
  ): NotificationRemoteDeliveryAnswer => ({ status: 'rejected', reason, providerCode });

  return {
    id: devvitNotificationProviderId,
    async send(request) {
      if (request.recipient.kind !== 'platform-user') {
        return rejected('configuration', devvitNotificationProviderCodes.deviceRecipient);
      }
      const userId = request.recipient.id;
      if (!devvitUserIdPattern.test(userId)) {
        return rejected('recipient', devvitNotificationProviderCodes.recipientInvalid);
      }
      const link = request.link;
      if (link === undefined || !devvitNotificationLinkPattern.test(link)) {
        return rejected('configuration', devvitNotificationProviderCodes.linkInvalid);
      }
      const { title, body } = request.content;
      if (title === undefined || body === undefined || title.trim() === '' || body.trim() === '') {
        // A host template or an empty text: Devvit sends the title and body it is given.
        return rejected('configuration', devvitNotificationProviderCodes.textMissing);
      }
      if (devvitNotificationTextLength(title) > devvitNotificationTitleMaxLength) {
        return rejected('configuration', devvitNotificationProviderCodes.titleTooLong);
      }
      if (devvitNotificationTextLength(body) > devvitNotificationBodyMaxLength) {
        return rejected('configuration', devvitNotificationProviderCodes.bodyTooLong);
      }
      if (title.includes('{{') || body.includes('{{')) {
        // From template data or from a catalog brace outside a `{{name}}`
        // placeholder: either way the operator should see it.
        return rejected('configuration', devvitNotificationProviderCodes.templateSyntax);
      }
      const report = (
        source: 'answer' | 'thrown',
        message: string,
        answer: NotificationRemoteDeliveryAnswer,
      ): NotificationRemoteDeliveryAnswer => {
        try {
          input.onEnqueueError?.({
            sendKey: request.sendKey,
            source,
            message,
            answer: answer.status,
            ...reasonOf(answer),
          });
        } catch {
          // A failing log never changes the answer.
        }
        return answer;
      };
      const failure = (
        source: 'answer' | 'thrown',
        message: string,
        fallback: 'rate-limited' | 'recipient' | 'configuration' | 'ambiguous',
      ): NotificationRemoteDeliveryAnswer => {
        let kind = fallback;
        let note = '';
        try {
          kind = input.classifyEnqueueError?.(message, source) ?? fallback;
        } catch (error) {
          // A failing classifier keeps the default answer; the report says so.
          note = ` (classifyEnqueueError threw: ${error instanceof Error ? error.message : String(error)})`;
        }
        // The provider code follows the final answer, after any override; a
        // thrown call keeps DEVVIT_ENQUEUE_FAILED, which names its source.
        let providerCode: string = devvitNotificationProviderCodes.enqueueRejected;
        if (source === 'thrown') {
          providerCode = devvitNotificationProviderCodes.enqueueFailed;
        } else if (kind === 'ambiguous') {
          providerCode = devvitNotificationProviderCodes.enqueueUnclassified;
        }
        let answer: NotificationRemoteDeliveryAnswer;
        if (kind === 'rate-limited') {
          // A daily limit lifts no sooner than an hour from now; any other
          // waits the service's default first delay.
          answer = dailyLimitWords.test(message)
            ? { status: 'rate-limited', retryAfterSeconds: 3600 }
            : { status: 'rate-limited' };
        } else if (kind === 'ambiguous') {
          answer = { status: 'ambiguous', providerCode };
        } else {
          answer = rejected(kind === 'recipient' ? 'recipient' : 'configuration', providerCode);
        }
        return report(source, `${message}${note}`, answer);
      };
      let response: DevvitEnqueueResponse;
      try {
        response = await input.notifications.enqueue({
          title,
          body,
          recipients: [{
            userId: userId as `t2_${string}`,
            link: link as `t1_${string}` | `t3_${string}`,
            data: {},
          }],
        });
      } catch (error) {
        return failure(
          'thrown',
          error instanceof Error ? error.message : String(error),
          'ambiguous',
        );
      }
      if (typeof response?.successCount === 'number' && response.successCount > 0) {
        return { status: 'accepted' };
      }
      const errors = Array.isArray(response?.errors) ? response.errors : [];
      const ours = errors.find((error) => error?.userId === userId)
        ?? errors.find((error) => error?.userId === undefined);
      const failed = typeof response?.failureCount === 'number' && response.failureCount > 0;
      if (ours === undefined && !failed) {
        // Neither queued nor refused: Devvit may still have queued it. No
        // error exists to classify, so the answer stays ambiguous.
        return report('answer', '(no success and no error in the answer)', {
          status: 'ambiguous',
          providerCode: devvitNotificationProviderCodes.enqueueUnanswered,
        });
      }
      const message = typeof ours?.message === 'string' ? ours.message : '';
      let fallback: 'rate-limited' | 'recipient' | 'ambiguous' = 'ambiguous';
      if (readsAsRateLimit(message)) {
        fallback = 'rate-limited';
      } else if (ours?.userId === userId && readsAsUserRefusal(message)) {
        // Only an error that names this recipient proves a refusal of the user.
        fallback = 'recipient';
      }
      return failure('answer', message, fallback);
    },
    async readPermission({ player }): Promise<NotificationPermissionState> {
      const userId = userIdOf(player);
      if (userId === undefined || !devvitUserIdPattern.test(userId)) {
        return 'unknown';
      }
      return (await input.notifications.isOptedIn(userId as `t2_${string}`)) ? 'granted' : 'prompt';
    },
  };
}

/**
 * The Devvit registry entry: the reference `devvit` entry of
 * `@mpgd/platform/notifications`, whose values this provider owns. 2 sends
 * per user per day is a provider limit (a day-long window suppresses), and
 * 25,000 per app per day is the `rate` the scheduler keeps to. A fresh copy
 * on every call.
 */
export function createDevvitNotificationProviderEntry(): NotificationProviderRegistryEntry {
  const entry = structuredClone(
    referenceNotificationProviders.devvit,
  ) as NotificationProviderRegistryEntry;
  return {
    ...entry,
    limits: [{ count: devvitNotificationsPerUserPerDay, windowSeconds: 86_400 }],
    rate: { count: devvitNotificationsPerAppPerDay, windowSeconds: 86_400 },
    mapping: {
      ...entry.mapping,
      title: { required: true, maxLength: devvitNotificationTitleMaxLength },
      body: { required: true, maxLength: devvitNotificationBodyMaxLength },
    },
  };
}

export interface CreateDevvitNotificationServiceInput extends Omit<
  CreateNotificationServiceInput,
  'store' | 'registry' | 'catalog' | 'resolvePlatformRecipient' | 'deployment'
> {
  /** `redis` from `@devvit/web/server`, for the Redis store; not needed with `store`. */
  readonly redis?: DevvitNotificationRedis;
  /** `notifications` from `@devvit/web/server`. */
  readonly notifications: DevvitNotificationsDeliveryClient;
  /** The game's topic catalog file, validated against the Devvit entry for the `reddit` target. */
  readonly catalog: unknown;
  readonly deployment?: NotificationDeployment;
  readonly store?: NotificationStore;
  readonly storeOptions?: CreateDevvitRedisNotificationStoreOptions;
  readonly classifyEnqueueError?: DevvitEnqueueErrorClassifier;
}

export interface DevvitNotificationService {
  readonly service: NotificationService;
  readonly store: NotificationStore;
  readonly registry: NotificationProviderRegistry;
  readonly catalog: NotificationServiceCatalog;
}

/**
 * The notifications v2 service as the Devvit server runs it: the Redis
 * store, the Devvit provider for the `reddit` target, and the catalog
 * checked against the Devvit entry (title ≤ 60 and body ≤ 100 code points,
 * an optional `t3_`/`t1_` default link). A player is a Reddit user id
 * (`context.userId`), which is also the recipient; any other player id has
 * no Devvit recipient (`unavailable: no-endpoint`).
 *
 * Players' own calls take a `devvitNotificationSession(userId)`. Server
 * reminders and their Devvit scheduler path come with the reminder
 * scheduler (S2).
 */
export function createDevvitNotificationService(
  input: CreateDevvitNotificationServiceInput,
): DevvitNotificationService {
  const {
    redis,
    notifications,
    catalog: catalogFile,
    deployment,
    store: givenStore,
    storeOptions,
    classifyEnqueueError,
    ...options
  } = input;
  if (givenStore !== undefined && (redis !== undefined || storeOptions !== undefined)) {
    throw new TypeError(
      'Pass either a notification store or Redis with its store options, not both.',
    );
  }
  let store: NotificationStore;
  if (givenStore !== undefined) {
    store = givenStore;
  } else if (redis === undefined) {
    throw new TypeError('The Devvit notifications service needs Redis or a notification store.');
  } else {
    // A scheduled purge runs in a time-bounded Devvit task: bound each call.
    store = createDevvitRedisNotificationStore(redis, {
      ...storeOptions,
      purgeLimit: storeOptions?.purgeLimit ?? devvitNotificationPurgeBatch,
    });
  }
  const registry = createNotificationProviderRegistry([
    {
      entry: createDevvitNotificationProviderEntry(),
      delivery: createDevvitNotificationDeliveryProvider({
        notifications,
        ...(classifyEnqueueError === undefined ? {} : { classifyEnqueueError }),
        onEnqueueError: (report) => {
          // Routine answers (a rate limit, a user's refusal) are not errors.
          if (report.answer !== 'ambiguous' && report.reason !== 'configuration') {
            return;
          }
          options.onError?.(
            new Error(`Devvit enqueue failed (${report.source}): ${report.message}`),
            {
              operation: 'devvit.enqueue',
              sendKey: report.sendKey,
              provider: devvitNotificationProviderId,
            },
          );
        },
      }),
      targets: [devvitNotificationTarget],
    },
  ]);
  const catalog = createNotificationServiceCatalog(catalogFile, {
    registry,
    ...(deployment === undefined ? {} : { deployment }),
  });
  const service = createNotificationService({
    ...options,
    store,
    registry,
    catalog,
    ...(deployment === undefined ? {} : { deployment }),
    resolvePlatformRecipient: ({ provider, player }) =>
      provider === devvitNotificationProviderId && devvitUserIdPattern.test(player)
        ? player
        : undefined,
  });
  return { service, store, registry, catalog };
}

/**
 * The notifications session of a Devvit request's logged-in user. A Devvit
 * player has no game-services session: the user id is the player, and one
 * session and installation per user, which no endpoint uses because Devvit
 * registers no device address.
 */
export function devvitNotificationSession(userId: string): NotificationSession {
  if (!devvitUserIdPattern.test(userId)) {
    throw new TypeError('A Devvit notifications session needs a t2_ Reddit user id.');
  }
  return { player: userId, sessionId: `devvit:${userId}`, installationId: `devvit:${userId}` };
}

/**
 * The Devvit scheduler tasks that keep the service's own work moving:
 * `dispatch` replays due rows (deferred sends, rate-limited ones, and
 * ambiguous answers once their lease ends) every minute, and `purge`
 * forgets old keys, history, and dead endpoints every five minutes. They
 * run, and use two of the installation's recurring tasks, even while the
 * game has no notifications service; such a run does no work. A game declares both in `devvit.json`
 * (`scheduler.tasks`, each with its `endpoint` and `cron`) and routes each
 * endpoint to `runDevvitNotificationTask`. S2's reminder scheduler takes
 * over the dispatch once it lands.
 *
 * Devvit scheduler: <https://developers.reddit.com/docs/versioned_docs/version-0.14/capabilities/server/scheduler>
 * (a recurring task is a `devvit.json` `scheduler.tasks` entry whose
 * endpoint matches `/internal/.+`, answered with a `TaskResponse`, `{}`).
 */
export const devvitNotificationSchedulerTasks = Object.freeze({
  dispatch: Object.freeze({
    name: 'mpgd-notifications-dispatch',
    endpoint: '/internal/scheduler/mpgd-notifications-dispatch',
    cron: '* * * * *',
  }),
  purge: Object.freeze({
    name: 'mpgd-notifications-purge',
    endpoint: '/internal/scheduler/mpgd-notifications-purge',
    cron: '*/5 * * * *',
  }),
} as const);

export type DevvitNotificationTask = keyof typeof devvitNotificationSchedulerTasks;

/** Due sends one dispatch task replays at most. */
export const devvitNotificationDispatchBatch = 100;

/**
 * Rows of each kind one purge task deletes at most (the Redis store's
 * `purgeLimit`). Every five minutes that is 57,600 a day of each kind,
 * above the 25,000 sends a day Devvit allows an app.
 */
export const devvitNotificationPurgeBatch = 200;

/**
 * Due sends one `dispatchDue` call of a dispatch task replays. The budget is
 * checked between chunks, so a run lasts the budget plus at most one chunk.
 */
const dispatchChunk = 10;

/**
 * A dispatch task starts no chunk after this long. Devvit documents no time
 * limit for a scheduler task; this keeps a run well inside the next minute's.
 */
export const devvitNotificationDispatchBudgetMs = 20_000;

/** The task an internal scheduler endpoint names, or `undefined` for any other path. */
export function devvitNotificationTaskForEndpoint(pathname: string): DevvitNotificationTask | undefined {
  for (const [task, declared] of Object.entries(devvitNotificationSchedulerTasks)) {
    if (declared.endpoint === pathname) {
      return task as DevvitNotificationTask;
    }
  }
  return undefined;
}

export type DevvitNotificationTaskResult =
  | {
      readonly task: 'dispatch';
      readonly replayed: number;
      readonly failed: number;
    }
  | {
      readonly task: 'purge';
      readonly sends: number;
      readonly history: number;
      readonly endpoints: number;
    };

/**
 * Runs one scheduler task with a bounded batch. `dispatch` replays at most
 * `dispatchLimit` (100, a positive integer) due sends in chunks of 10 and
 * starts no chunk after `budgetMs` (20 seconds). The run ends at a chunk
 * in which no send produced a result (nothing is due, or every send
 * failed), at a chunk that repeats a send or lists fewer sends than it
 * asked for, and once it has counted 10 failures. A send that fails after
 * its row was claimed backs off for a minute; one that fails before its
 * claim stays due and the next chunk lists it again, so the failure cap
 * bounds how often one run retries and reports it. `replayed` counts the
 * sends that produced a result, each once; `failed` counts failures, a
 * send listed again counting again. `purge` deletes at most the store's `purgeLimit` rows of each kind (200 for the store
 * `createDevvitNotificationService` builds). A backlog drains over the
 * following runs.
 */
export async function runDevvitNotificationTask(
  service: Pick<NotificationService, 'dispatchDue' | 'purge'>,
  task: DevvitNotificationTask,
  options: {
    readonly dispatchLimit?: number;
    readonly budgetMs?: number;
    /** Milliseconds now; `Date.now` by default. Tests inject it. */
    readonly clock?: () => number;
  } = {},
): Promise<DevvitNotificationTaskResult> {
  if (task === 'dispatch') {
    const limit = options.dispatchLimit ?? devvitNotificationDispatchBatch;
    const budgetMs = options.budgetMs ?? devvitNotificationDispatchBudgetMs;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('dispatchLimit must be a positive integer');
    }
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new RangeError('budgetMs must be a positive number of milliseconds');
    }
    const clock = options.clock ?? Date.now;
    const deadline = clock() + budgetMs;
    const seen = new Set<string>();
    let failed = 0;
    let asked = 0;
    while (asked < limit && clock() < deadline) {
      const chunk = Math.min(dispatchChunk, limit - asked);
      asked += chunk;
      const answer = await service.dispatchDue({ limit: chunk });
      failed += answer.failed;
      const fresh = answer.results.filter((result) => !seen.has(result.sendKey));
      for (const result of fresh) {
        seen.add(result.sendKey);
      }
      // No result (nothing due, or every send failed), a repeated send, a
      // short listing, or a chunk's worth of failures (a send that failed
      // before its claim is listed again by every chunk): leave the rest to
      // the next run. `failed` may count a send that also has a result, so a
      // full chunk never reads as short; a skipped key can make one read
      // short early.
      if (
        fresh.length === 0
        || fresh.length < answer.results.length
        || answer.results.length + answer.failed < chunk
        || failed >= dispatchChunk
      ) {
        break;
      }
    }
    return { task, replayed: seen.size, failed };
  }
  const counts = await service.purge();
  return { task, ...counts };
}
