import { thrownMessage } from '@mpgd/bridge';
import {
  createNotificationProviderRegistry,
  createNotificationService,
  createNotificationServiceCatalog,
  type CreateNotificationServiceInput,
  type NotificationBulkDeliverOptions,
  type NotificationBulkDeliveryResult,
  type NotificationProviderRegistry,
  type NotificationRemoteDeliveryAnswer,
  type NotificationRemoteDeliveryProvider,
  type NotificationRemoteDeliveryRequest,
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
  /**
   * One page of the users opted in to notifications, oldest opt-in first
   * (`ListOptedInUsersOptions`/`ListOptedInUsersResponse`); only
   * `runDevvitNotificationBulkPage` needs it.
   */
  listOptedInUsers?(options: {
    limit?: number;
    after?: string | undefined;
  }): Promise<{ readonly userIds: readonly string[]; readonly next?: string | undefined }>;
}

/**
 * Recipients one `enqueue` call takes (`EnqueueOptions['recipients']`: "Max
 * number of recipients is 1000" in `@devvit/notifications` 0.15.0), and
 * users one `listOptedInUsers` page answers ("The default and maximum limit
 * is 1,000" in the 0.15 push notification guide).
 */
export const devvitNotificationEnqueueMaxRecipients = 1_000;

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
  /** A bulk `enqueue` counted some of the unnamed recipients as sent and some not, without naming them. */
  enqueuePartial: 'DEVVIT_ENQUEUE_PARTIAL',
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
  // A size or text word plus refusal evidence marks a length or content
  // refusal, whatever period it names. Such a refusal is configuration: the
  // same send fails again, so it must not be replayed as ambiguous. A field
  // name alone ("payload service temporarily unavailable") is not evidence.
  // "Message" may count sends ("daily message limit"), so it marks a rate
  // limit only when the message names no period and no size or text refusal.
  if (readsAsSizeOrTextRefusal(message)) {
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

/** Title, character, length, link, and the other size or text words a refusal names. */
const sizeOrTextWords = /\b(?:characters?|length|long|size|bytes?|title|body|link|text|content|payload|template)\b/iu;

/**
 * Words that prove a deterministic refusal. A field name alone is not one:
 * "payload service temporarily unavailable" stays ambiguous and is replayed.
 */
const refusalEvidence = /\b(?:too long|exceed(?:s|ed|ing)?|invalid|not allowed|not found|does not exist)\b/iu;

function readsAsSizeOrTextRefusal(message: string): boolean {
  return sizeOrTextWords.test(message) && refusalEvidence.test(message);
}

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
 *   because the same send would fail again. An `enqueue` error that reads
 *   as a length or content refusal (a size or text word, and refusal
 *   evidence such as too long, exceeds, invalid, not allowed, or not found)
 *   is `rejected` with reason `configuration` once, not replayed. A field
 *   name alone stays ambiguous.
 * - **Answers.** `successCount` above 0 is `accepted`. Otherwise an error for
 *   this recipient (or for no named user) is a failure Devvit counted:
 *   a message that reads as a rate limit is `rate-limited` (deferred, for
 *   at most a day), one that reads as a length or content refusal is
 *   `rejected` with reason `configuration`, one that reads as the user's
 *   refusal (not opted in, no such user) in an error that names this
 *   recipient is `rejected` with reason `recipient`. Any other error is
 *   `ambiguous` (provider code `DEVVIT_ENQUEUE_UNCLASSIFIED`): Devvit
 *   documents no error messages, so an unknown one is neither proof of a
 *   setup error nor of a refusal. The service reports it to the operator
 *   and replays it after each lease, which doubles from the claim lease up
 *   to an hour, for at most 24 hours after the first attempt
 *   (`notificationAmbiguousReplayHours`): with the default 300-second
 *   lease, at most 27 calls. A call that throws, or an answer that counts
 *   neither a success nor a failure, is `ambiguous` too: Devvit may have
 *   queued it, and `enqueue` takes no idempotency key, so a replay may
 *   show twice.
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

  /** The text, link, and recipient one send needs, or the answer that refuses it without a call. */
  const precheck = (
    request: NotificationRemoteDeliveryRequest,
  ):
    | { readonly answer: NotificationRemoteDeliveryAnswer }
    | { readonly userId: string; readonly link: string; readonly title: string; readonly body: string } => {
    if (request.recipient.kind !== 'platform-user') {
      return { answer: rejected('configuration', devvitNotificationProviderCodes.deviceRecipient) };
    }
    const userId = request.recipient.id;
    if (!devvitUserIdPattern.test(userId)) {
      return { answer: rejected('recipient', devvitNotificationProviderCodes.recipientInvalid) };
    }
    const link = request.link;
    if (link === undefined || !devvitNotificationLinkPattern.test(link)) {
      return { answer: rejected('configuration', devvitNotificationProviderCodes.linkInvalid) };
    }
    const { title, body } = request.content;
    if (title === undefined || body === undefined || title.trim() === '' || body.trim() === '') {
      // A host template or an empty text: Devvit sends the title and body it is given.
      return { answer: rejected('configuration', devvitNotificationProviderCodes.textMissing) };
    }
    if (devvitNotificationTextLength(title) > devvitNotificationTitleMaxLength) {
      return { answer: rejected('configuration', devvitNotificationProviderCodes.titleTooLong) };
    }
    if (devvitNotificationTextLength(body) > devvitNotificationBodyMaxLength) {
      return { answer: rejected('configuration', devvitNotificationProviderCodes.bodyTooLong) };
    }
    if (title.includes('{{') || body.includes('{{')) {
      // From template data or from a catalog brace outside a `{{name}}`
      // placeholder: either way the operator should see it.
      return { answer: rejected('configuration', devvitNotificationProviderCodes.templateSyntax) };
    }
    return { userId, link, title, body };
  };
  /** Tells `onEnqueueError` about a failure; never changes the answer. */
  const report = (
    sendKey: string,
    source: 'answer' | 'thrown',
    message: string,
    answer: NotificationRemoteDeliveryAnswer,
  ): NotificationRemoteDeliveryAnswer => {
    try {
      input.onEnqueueError?.({
        sendKey,
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
  /** The answer for an `enqueue` failure after `classifyEnqueueError`, reported. */
  const failure = (
    sendKey: string,
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
      note = ` (classifyEnqueueError threw: ${thrownMessage(error)})`;
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
    return report(sendKey, source, `${message}${note}`, answer);
  };
  /** The default answer for an error message: a rate limit, a text refusal, or, named for the user, their refusal. */
  const fallbackOf = (
    message: string,
    named: boolean,
  ): 'rate-limited' | 'recipient' | 'configuration' | 'ambiguous' => {
    if (readsAsRateLimit(message)) {
      return 'rate-limited';
    }
    if (readsAsSizeOrTextRefusal(message)) {
      return 'configuration';
    }
    // Only an error that names this recipient proves a refusal of the user.
    return named && readsAsUserRefusal(message) ? 'recipient' : 'ambiguous';
  };

  return {
    id: devvitNotificationProviderId,
    bulk: { maxRecipients: devvitNotificationEnqueueMaxRecipients, perRecipientOutcomes: true },
    /**
     * One `enqueue` per distinct title and body (Devvit takes one title and
     * body a call, with a link per recipient), each user once a call. Each
     * recipient's answer comes from its own error, or from the counts:
     * - an error that names the recipient classifies as for `send`;
     * - the recipients no error names are `accepted` only when
     *   `successCount` equals their number. With `successCount` 0 none of
     *   them was queued, and the errors that name no user decide as for
     *   `send` when they agree (else `ambiguous`, replayed: nothing was
     *   queued). Any other count means some were queued and some not,
     *   without saying which: `ambiguous` with `unattributed` (code
     *   `DEVVIT_ENQUEUE_PARTIAL`), not replayed, since `enqueue` takes no
     *   idempotency key and a replay would notify the queued ones again.
     * - A call that throws is `ambiguous` for each of its recipients.
     */
    async sendBatch(requests) {
      const answers: (NotificationRemoteDeliveryAnswer | undefined)[] = requests.map(() => undefined);
      const calls: { readonly title: string; readonly body: string; readonly members: { index: number; userId: string; link: string }[] }[] = [];
      requests.forEach((request, index) => {
        const checked = precheck(request);
        if ('answer' in checked) {
          answers[index] = checked.answer;
          return;
        }
        // The first call of this text that does not have the user yet.
        let call = calls.find((candidate) =>
          candidate.title === checked.title
          && candidate.body === checked.body
          && candidate.members.length < devvitNotificationEnqueueMaxRecipients
          && !candidate.members.some((member) => member.userId === checked.userId));
        if (call === undefined) {
          call = { title: checked.title, body: checked.body, members: [] };
          calls.push(call);
        }
        call.members.push({ index, userId: checked.userId, link: checked.link });
      });
      for (const call of calls) {
        const keyOf = (index: number): string => requests[index]?.sendKey ?? '';
        let response: DevvitEnqueueResponse;
        try {
          response = await input.notifications.enqueue({
            title: call.title,
            body: call.body,
            recipients: call.members.map((member) => ({
              userId: member.userId as `t2_${string}`,
              link: member.link as `t1_${string}` | `t3_${string}`,
              data: {},
            })),
          });
        } catch (error) {
          const message = thrownMessage(error);
          for (const member of call.members) {
            answers[member.index] = failure(keyOf(member.index), 'thrown', message, 'ambiguous');
          }
          continue;
        }
        const errors = Array.isArray(response?.errors) ? response.errors : [];
        const users = new Set(call.members.map((member) => member.userId));
        const unnamed = errors.filter((error) => typeof error?.userId !== 'string' || !users.has(error.userId));
        const rest: typeof call.members = [];
        for (const member of call.members) {
          const ours = errors.find((error) => error?.userId === member.userId);
          if (ours === undefined) {
            rest.push(member);
            continue;
          }
          const message = typeof ours.message === 'string' ? ours.message : '';
          answers[member.index] = failure(keyOf(member.index), 'answer', message, fallbackOf(message, true));
        }
        if (rest.length === 0) {
          continue;
        }
        const succeeded = response?.successCount;
        if (typeof succeeded === 'number' && succeeded === rest.length) {
          for (const member of rest) {
            answers[member.index] = { status: 'accepted' };
          }
          continue;
        }
        if (succeeded === 0) {
          const messages = unnamed.map((error) => (typeof error?.message === 'string' ? error.message : ''));
          const kinds = new Set(messages.map((message) => fallbackOf(message, false)));
          const failed = typeof response?.failureCount === 'number' && response.failureCount > call.members.length - rest.length;
          for (const member of rest) {
            if (messages.length > 0) {
              // Errors that agree decide for every unnamed recipient; errors that differ prove nothing for any one.
              answers[member.index] = failure(
                keyOf(member.index),
                'answer',
                messages[0] ?? '',
                kinds.size === 1 ? ([...kinds][0] ?? 'ambiguous') : 'ambiguous',
              );
            } else if (failed) {
              answers[member.index] = failure(keyOf(member.index), 'answer', '', 'ambiguous');
            } else {
              // Neither queued nor refused: Devvit may still have queued it.
              answers[member.index] = report(keyOf(member.index), 'answer', '(no success and no error in the answer)', {
                status: 'ambiguous',
                providerCode: devvitNotificationProviderCodes.enqueueUnanswered,
              });
            }
          }
          continue;
        }
        for (const member of rest) {
          answers[member.index] = report(
            keyOf(member.index),
            'answer',
            `(successCount ${String(succeeded)} for ${rest.length} recipients no error names)`,
            typeof succeeded === 'number'
              ? { status: 'ambiguous', providerCode: devvitNotificationProviderCodes.enqueuePartial, unattributed: true }
              : { status: 'ambiguous', providerCode: devvitNotificationProviderCodes.enqueueUnanswered },
          );
        }
      }
      return answers.map((answer): NotificationRemoteDeliveryAnswer => answer ?? { status: 'ambiguous' });
    },
    async send(request) {
      const checked = precheck(request);
      if ('answer' in checked) {
        return checked.answer;
      }
      const { userId, link, title, body } = checked;
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
        return failure(request.sendKey, 'thrown', thrownMessage(error), 'ambiguous');
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
        return report(request.sendKey, 'answer', '(no success and no error in the answer)', {
          status: 'ambiguous',
          providerCode: devvitNotificationProviderCodes.enqueueUnanswered,
        });
      }
      const message = typeof ours?.message === 'string' ? ours.message : '';
      let fallback: 'rate-limited' | 'recipient' | 'configuration' | 'ambiguous' = 'ambiguous';
      if (readsAsRateLimit(message)) {
        fallback = 'rate-limited';
      } else if (readsAsSizeOrTextRefusal(message)) {
        fallback = 'configuration';
      } else if (ours?.userId === userId && readsAsUserRefusal(message)) {
        // Only an error that names this recipient proves a refusal of the user.
        fallback = 'recipient';
      }
      return failure(request.sendKey, 'answer', message, fallback);
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
 * Players' own calls take `devvitNotificationSessionFromContext(context)`
 * (the request's `context.userId`). `devvitNotificationSession(userId)` remains
 * for a caller that already holds that id. Server
 * reminders (`setReminder`) fire through the `dispatch` scheduler task
 * (`runDevvitNotificationTask`). The scheduler pushes no consent notices
 * through Devvit: its entry fixes the title and body per topic, so it does
 * not carry notices (`notificationProviderCarriesNotices`).
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
 *
 * @deprecated Prefer `devvitNotificationSessionFromContext`. A caller-supplied
 * id can name a different player than the request.
 */
export function devvitNotificationSession(userId: string): NotificationSession {
  if (!devvitUserIdPattern.test(userId)) {
    throw new TypeError('A Devvit notifications session needs a t2_ Reddit user id.');
  }
  return { player: userId, sessionId: `devvit:${userId}`, installationId: `devvit:${userId}` };
}

/** The Devvit request context fields this session reads (`context` from `@devvit/web/server`). */
export interface DevvitNotificationSessionContext {
  /** The logged-in Reddit user of the current request (`context.userId`); absent or `null` when logged out. */
  readonly userId?: string | null | undefined;
}

/**
 * The notifications session of the current Devvit request. The player is
 * `context.userId`, not a string the caller supplies, so a handler cannot
 * record consent or set a reminder for a different user by passing one.
 * A missing or non-`t2_` id throws: a logged-out request has no session.
 */
export function devvitNotificationSessionFromContext(
  context: DevvitNotificationSessionContext,
): NotificationSession {
  if (typeof context.userId !== 'string') {
    throw new TypeError('A Devvit notifications session needs the request context user id.');
  }
  return devvitNotificationSession(context.userId);
}

/**
 * The Devvit scheduler tasks that keep the service's own work moving:
 * `dispatch` runs the service's scheduler (`runScheduler`) every minute,
 * which turns due server reminders into sends and replays due rows
 * (deferred sends, rate-limited ones, and ambiguous answers once their
 * lease ends), and `purge` forgets old keys,
 * history, and dead endpoints every five minutes. They run, and use two of
 * the installation's recurring tasks, even while the game has no
 * notifications service; such a run does no work. A game declares both in
 * `devvit.json` (`scheduler.tasks`, each with its `endpoint` and `cron`)
 * and routes each endpoint to `runDevvitNotificationTask`.
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

/**
 * Due schedule entries, and due sends, one scheduler round of a dispatch
 * task takes at most (`runScheduler`'s `limit`).
 */
export const devvitNotificationDispatchBatch = 10;

/**
 * Rows of each kind one purge task deletes at most (the Redis store's
 * `purgeLimit`). Every five minutes that is 57,600 a day of each kind,
 * above the 25,000 sends a day Devvit allows an app.
 */
export const devvitNotificationPurgeBatch = 200;

/**
 * A dispatch task starts no scheduler round after this long
 * (`runScheduler`'s `budgetMs`), so a run lasts the budget plus at most one
 * round. Devvit documents no time limit for a scheduler task; this keeps a
 * run well inside the next minute's.
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
      /**
       * The sends the run touched, whatever their outcome (delivered, in
       * flight, deferred, or refused by the gate): fired reminders and due rows.
       */
      readonly touched: number;
      readonly failed: number;
    }
  | {
      readonly task: 'purge';
      readonly sends: number;
      readonly history: number;
      readonly endpoints: number;
    };

/**
 * Runs one scheduler task.
 *
 * `dispatch` is one `runScheduler` run, bounded by time: rounds of at most
 * `dispatchLimit` (10, a positive integer) due schedule entries and due
 * sends, which go on while a round filled its batch and got somewhere, and
 * start no round after `budgetMs` (20 seconds), so a run lasts the budget
 * plus at most one round; the sends of a run are not otherwise capped. Due
 * rows count against the Devvit entry's `rate`, 25,000 a day, a daily cap
 * rather than a spread. One failing send never stops the others.
 *
 * `purge` deletes at most the store's `purgeLimit` rows of each kind (200
 * for the store `createDevvitNotificationService` builds). A backlog
 * drains over the following runs.
 */
export async function runDevvitNotificationTask(
  service: Pick<NotificationService, 'runScheduler' | 'purge'>,
  task: DevvitNotificationTask,
  options: {
    readonly dispatchLimit?: number;
    readonly budgetMs?: number;
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
    const run = await service.runScheduler({ limit, budgetMs });
    return { task, touched: run.results.length, failed: run.failed };
  }
  const counts = await service.purge();
  return { task, ...counts };
}

/** One page of a bulk send to the users opted in on Devvit. */
export interface RunDevvitNotificationBulkPageInput {
  readonly service: Pick<NotificationService, 'deliverBulk'>;
  /** `notifications` from `@devvit/web/server`, for `listOptedInUsers`. */
  readonly notifications: Pick<DevvitNotificationsDeliveryClient, 'listOptedInUsers'>;
  /** The campaign's key; each user's send key is `<idempotencyKey>:<encodeURIComponent(userId)>`. */
  readonly idempotencyKey: string;
  readonly topic: string;
  /** The post or comment every notification opens, unless the topic's `reddit` mapping has one. */
  readonly link?: string;
  readonly templateData?: Readonly<Record<string, string | number | boolean>>;
  /** The cursor `next` answered for the page before; the first page without it. */
  readonly after?: string;
  /** Users per page, 1 to 1,000 (the most `listOptedInUsers` and `enqueue` take); 1,000 by default. */
  readonly limit?: number;
  readonly options?: NotificationBulkDeliverOptions;
}

export interface DevvitNotificationBulkPageResult {
  /** The bulk send's answer for this page; `undefined` when the page named no user. */
  readonly result?: NotificationBulkDeliveryResult;
  /** The cursor of the next page; `undefined` once the list is done. */
  readonly next?: string;
  /**
   * Whether every user on the page was attempted. While it is false, run the
   * same page again (the same `after`) later: users already sent answer from
   * the ledger, and the rest are sent once the budgets allow.
   */
  readonly complete: boolean;
}

/**
 * Sends one page of `listOptedInUsers` through `deliverBulk` (RFC open
 * question 5): Devvit's opt-in list only picks the audience. The kit's gate
 * still decides each user: it reads `isOptedIn` again at send time and the
 * kit's own records (topic preference, frequency, quiet hours), so a user
 * opted in on Devvit whom the gate refuses is not sent to. Devvit's limits
 * hold per user (2 a day, the entry's provider limit, which suppresses the
 * excess) and per app (25,000 a day, the entry's `rate`: users past it answer
 * `not-attempted`, `provider-rate`, and are sent when the same page runs
 * again after the window frees). Run it from a scheduler task or a
 * moderator action on the Devvit server, never from a player's request.
 */
export async function runDevvitNotificationBulkPage(
  input: RunDevvitNotificationBulkPageInput,
): Promise<DevvitNotificationBulkPageResult> {
  const limit = input.limit ?? devvitNotificationEnqueueMaxRecipients;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > devvitNotificationEnqueueMaxRecipients) {
    throw new RangeError(
      `limit must be an integer from 1 to ${devvitNotificationEnqueueMaxRecipients}.`,
    );
  }
  const list = input.notifications.listOptedInUsers;
  if (list === undefined) {
    throw new TypeError('The Devvit notifications client has no listOptedInUsers.');
  }
  const page = await list.call(input.notifications, {
    limit,
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  const userIds = Array.isArray(page?.userIds) ? page.userIds : [];
  const next = typeof page?.next === 'string' && page.next.length > 0 && userIds.length > 0
    ? page.next
    : undefined;
  const players = [
    ...new Set(userIds.filter((id) => typeof id === 'string' && devvitUserIdPattern.test(id))),
  ];
  if (players.length === 0) {
    return { ...(next === undefined ? {} : { next }), complete: true };
  }
  const result = await input.service.deliverBulk(
    {
      idempotencyKey: input.idempotencyKey,
      provider: devvitNotificationProviderId,
      topic: input.topic,
      recipients: players.map((player) => ({ player })),
      ...(input.link === undefined ? {} : { link: input.link }),
      ...(input.templateData === undefined ? {} : { templateData: input.templateData }),
    },
    input.options,
  );
  return {
    result,
    ...(next === undefined ? {} : { next }),
    complete: result.summary.notAttempted === 0,
  };
}
