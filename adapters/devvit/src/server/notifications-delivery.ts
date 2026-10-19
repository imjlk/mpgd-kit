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
 * (`source: 'answer'`, nothing was queued for the user) or a call that threw
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
  if (/\b(?:characters?|length|long|title|body|link|size|bytes?)\b/iu.test(message)) {
    return false;
  }
  return /\blimit\b/iu.test(message)
    && /\b(?:exceeded|reached|hit)\b/iu.test(message)
    && /\b(?:notifications?|daily|per[- ]?(?:user|app|day)|user|app|send(?:s|ing)?)\b/iu.test(message);
}

/**
 * A message that reads as this user's refusal: not opted in, opted out, no
 * such user or account. It counts only for an error that names this
 * recipient.
 */
const recipientMessage =
  /\bopt(?:ed|ing)?[ -]?(?:in|out)\b|\b(?:user|account|recipient)\b[^.]*\b(?:not found|does not exist|deleted|suspended|banned)\b|\bnot subscribed\b|\bnotifications? (?:are )?disabled\b/iu;

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
 *   this recipient (or for no named user) proves nothing was queued for it:
 *   a message that reads as a rate limit is `rate-limited` (deferred, for
 *   at most a day), one that reads as the user's refusal (not opted in, no
 *   such user) in an error that names this recipient is `rejected` with
 *   reason `recipient`, and any other message
 *   is `rejected` with reason `configuration`, which the service reports to
 *   the operator. A call that throws, or an answer that counts neither a
 *   success nor a failure, is `ambiguous`: Devvit may have queued it, and
 *   `enqueue` takes no idempotency key, so a replay may show twice.
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
            ...(answer.status === 'rejected' ? { reason: answer.reason === 'recipient' ? 'recipient' : 'configuration' } : {}),
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
        providerCode: string,
      ): NotificationRemoteDeliveryAnswer => {
        let kind = fallback;
        let note = '';
        try {
          kind = input.classifyEnqueueError?.(message, source) ?? fallback;
        } catch (error) {
          // A failing classifier keeps the default answer; the report says so.
          note = ` (classifyEnqueueError threw: ${error instanceof Error ? error.message : String(error)})`;
        }
        let answer: NotificationRemoteDeliveryAnswer;
        if (kind === 'rate-limited') {
          answer = { status: 'rate-limited' };
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
          devvitNotificationProviderCodes.enqueueFailed,
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
      let fallback: 'rate-limited' | 'recipient' | 'configuration' = 'configuration';
      if (readsAsRateLimit(message)) {
        fallback = 'rate-limited';
      } else if (ours?.userId === userId && recipientMessage.test(message)) {
        // Only an error that names this recipient proves a refusal of the user.
        fallback = 'recipient';
      }
      return failure('answer', message, fallback, devvitNotificationProviderCodes.enqueueRejected);
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
    store = createDevvitRedisNotificationStore(redis, storeOptions);
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
