import {
  notificationTemplateDataIssue,
  referenceNotificationProviders,
  type NotificationDeliveryProviderEntry,
  type NotificationProviderId,
  type NotificationTemplateData,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import type { AppsInTossMutualTlsFetcher } from '../apps-in-toss-partner-api.js';

/**
 * Apps in Toss functional-message delivery provider (notifications RFC
 * "Delivery providers -> Apps in Toss"). It sends one `send-message` call per
 * recipient over the partner API's mTLS client certificate and answers one of
 * the RFC's provider answers ("Provider answers"). The backend's policy gate
 * decides whether to call it and maps each answer to a delivery outcome; this
 * module keeps no ledger, makes no gate decision, and uses only `fetch`
 * through the injected mTLS fetcher, so it runs on Cloudflare Workers. Its
 * `{ id, send }` shape is built from `@mpgd/platform/notifications` types and
 * literal unions only, so the game-services delivery registry takes it
 * structurally.
 *
 * Partner API reference, checked 2026-10-19:
 * https://developers-apps-in-toss.toss.im/api/push.md ("메시지 발송하기") and
 * https://developers-apps-in-toss.toss.im/documentation/common/growth/smart-message.md
 * - `POST /api-partner/v1/apps-in-toss/messenger/send-message` with
 *   `x-toss-user-key` or `x-anon-key`, and `{ templateSetCode, context }`.
 * - Business errors come as HTTP 200 with `resultType: 'FAIL'` and
 *   `error.errorCode`: 5004 (template not approved), 4034 (no workspace or no
 *   access to it), 4010 (credentials not found), 4095 (rate limit, with
 *   `error.data.retryAfterSeconds`). Other `resultType` values are
 *   `HTTP_TIMEOUT`, `NETWORK_ERROR`, `EXECUTION_FAIL`, `INTERRUPTED`, and
 *   `INTERNAL_ERROR`. The API may pass through undocumented codes of internal
 *   systems; they are failures.
 * - A `SUCCESS` answer counts the messages sent per channel (push, inbox, SMS,
 *   Alimtalk, Friendtalk) and lists each channel's sent and failed messages,
 *   a failed one with a free-text `reachedFailReason`.
 * - The documentation names no recipient-level code, including none for a
 *   recipient who has not agreed to the template. `agreementErrorCodes` and
 *   `agreementFailReasons` let a deployment name the ones it observes, so
 *   such an answer is `rejected` with reason `agreement` and records the
 *   denial; without them it is reason `recipient`.
 * - Limits: 15,000 calls per minute per app and 10 per minute per user, the
 *   reference registry entry's `rate` and `limits`, which the scheduler and
 *   the gate apply.
 */

export const aitFunctionalMessageProviderId = 'apps-in-toss' as const satisfies NotificationProviderId;

export const aitFunctionalMessagePath = 'api-partner/v1/apps-in-toss/messenger/send-message';

// The same values as `appsInTossPartnerApiBaseUrl` and
// `defaultAppsInTossPartnerApiTimeoutMs` (a test keeps them equal), kept here
// so this module loads none of the partner client's code.
export const defaultAitFunctionalMessageBaseUrl = 'https://apps-in-toss-api.toss.im';

export const defaultAitFunctionalMessageTimeoutMs = 10_000;

/** The longest `Retry-After` the provider passes on; the scheduler backs off from it. */
export const maximumAitFunctionalMessageRetryAfterSeconds = 86_400;

/** The channels a `send-message` answer reports. */
export type AitFunctionalMessageChannel = 'push' | 'inbox' | 'sms' | 'alimtalk' | 'friendtalk';

export interface AitFunctionalMessageChannelResult {
  readonly sent: readonly { readonly contentId: string }[];
  readonly failed: readonly { readonly contentId: string; readonly reachedFailReason?: string }[];
}

export type AitFunctionalMessageChannelResults = Readonly<
  Record<AitFunctionalMessageChannel, AitFunctionalMessageChannelResult>
>;

/** Why a provider rejected a send (RFC "Provider answers"). */
export type AitFunctionalMessageRejection = 'configuration' | 'recipient' | 'agreement';

/**
 * One of the RFC's provider answers. `unregistered` never occurs: recipients
 * are platform users, not device addresses. `providerCode` keeps the partner
 * API's `errorCode` or `resultType` (or `TIMEOUT`, `ABORTED`,
 * `TRANSPORT_ERROR`) for logs, and `channels` the per-channel lists of a
 * `SUCCESS` answer.
 */
export type AitFunctionalMessageAnswer =
  | {
      readonly status: 'accepted';
      /** The first sent message's `contentId`. */
      readonly providerMessageId?: string;
      readonly messageCount: number;
      readonly channels: AitFunctionalMessageChannelResults;
    }
  | {
      readonly status: 'rate-limited';
      readonly retryAfterSeconds?: number;
      readonly providerCode?: string;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AitFunctionalMessageRejection;
      readonly providerCode?: string;
      readonly channels?: AitFunctionalMessageChannelResults;
    }
  | { readonly status: 'ambiguous'; readonly providerCode?: string };

/**
 * Who one delivery goes to. Apps in Toss recipients are platform users whose
 * id the backend resolved from the player's authenticated identity, never
 * from a key the client sent; a device recipient is refused.
 */
export type AitFunctionalMessageRecipient =
  | { readonly kind: 'platform-user'; readonly id: string }
  | { readonly kind: 'device'; readonly installationId: string; readonly address: unknown };

export interface AitFunctionalMessageDeliveryRequest {
  readonly recipient: AitFunctionalMessageRecipient;
  /** The topic as declared for this provider: its mapping carries `templateSetCode`. */
  readonly topic: Pick<NotificationTopicDeclaration, 'id' | 'mapping'>;
  /** The template's `context` values. */
  readonly templateData?: NotificationTemplateData;
  readonly signal?: AbortSignal;
}

export interface CreateAitFunctionalMessageDeliveryProviderOptions {
  /** The partner API mTLS client, such as a Workers mTLS certificate binding (`env.BINDING`). */
  readonly mtls: AppsInTossMutualTlsFetcher;
  /**
   * Which partner key a recipient id is: a Toss login `userKey`
   * (`x-toss-user-key`) or a `User.getAnonymousKey` hash (`x-anon-key`).
   */
  readonly recipientKey: 'toss-user' | 'anonymous';
  readonly baseUrl?: string;
  /** 1 to 60,000 ms, as the partner API client accepts. */
  readonly timeoutMs?: number;
  /** `FAIL` error codes that mean the recipient has not agreed to the template. */
  readonly agreementErrorCodes?: readonly string[];
  /** `reachedFailReason` texts (trimmed) that mean the recipient has not agreed to the template. */
  readonly agreementFailReasons?: readonly string[];
  /** Further `FAIL` error codes that mean this recipient cannot receive the message. */
  readonly recipientErrorCodes?: readonly string[];
}

export interface AitFunctionalMessageDeliveryProvider {
  readonly id: typeof aitFunctionalMessageProviderId;
  /** The registry entry the policy gate reads for this provider. */
  readonly entry: NotificationDeliveryProviderEntry;
  send(request: AitFunctionalMessageDeliveryRequest): Promise<AitFunctionalMessageAnswer>;
}

/** Codes the documentation names for the project's setup or credentials. */
const configurationErrorCodes: ReadonlySet<string> = new Set(['5004', '4034', '4010']);
const rateLimitedErrorCode = '4095';
/** `resultType` values that cannot tell whether the message went out. */
const ambiguousResultTypes: ReadonlySet<string> = new Set([
  'HTTP_TIMEOUT',
  'NETWORK_ERROR',
  'EXECUTION_FAIL',
  'INTERRUPTED',
  'INTERNAL_ERROR',
]);
/** HTTP statuses that refuse the request itself, before anything is sent. */
const refusedRequestStatuses: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 413, 415, 422,
]);
const channelFields: Readonly<Record<AitFunctionalMessageChannel, string>> = {
  push: 'sentPush',
  inbox: 'sentInbox',
  sms: 'sentSms',
  alimtalk: 'sentAlimtalk',
  friendtalk: 'sentFriendtalk',
};
const maximumResponseBodyBytes = 256 * 1_024;
const maximumIdentifierLength = 2_048;
const maximumTimeoutMs = 60_000;

/**
 * Creates the provider. `send` never throws for a partner API answer: every
 * HTTP answer, transport failure, and timeout maps to a provider answer.
 *
 * - `SUCCESS` with at least one message sent on any channel is `accepted`.
 *   With none sent, the per-channel `fail` lists decide: `rejected` with
 *   reason `agreement` when a failure's `reachedFailReason` is one of
 *   `agreementFailReasons`, otherwise `recipient`.
 * - `FAIL` 4095 is `rate-limited` with `retryAfterSeconds` (at most a day);
 *   5004, 4034, and 4010 are `rejected` with reason `configuration`; a code
 *   in `agreementErrorCodes` or `recipientErrorCodes` is `rejected` with that
 *   reason. Any other code is `rejected` with reason `recipient` on HTTP 200
 *   and `configuration` when the HTTP status refused the request (400, 401,
 *   403, 404, 405, 413, 415, 422): a `FAIL` envelope reports a failed
 *   request, and answering `ambiguous` would replay a send that fails the
 *   same way after every lease: the RFC sets no limit on how often an
 *   `ambiguous` send is replayed (only the lease paces the replays). On any other status it is `ambiguous`, and so
 *   is a `FAIL` without a code. A `rate-limited` delay comes from
 *   `error.data.retryAfterSeconds`, else the `Retry-After` header.
 * - `HTTP_TIMEOUT`, `NETWORK_ERROR`, `EXECUTION_FAIL`, `INTERRUPTED`, and
 *   `INTERNAL_ERROR`, any HTTP 5xx, 408, or 425, a transport failure, a
 *   timeout, and an answer that cannot be read are `ambiguous`: the claim
 *   stays and the scheduler replays after the lease.
 * - HTTP 429 is `rate-limited` whatever its body (`retryAfterSeconds`, else
 *   `Retry-After` in seconds, when present); HTTP 400, 401, 403, 404, 405,
 *   413, 415, and 422 without a business error are `rejected` with reason
 *   `configuration`.
 * - A request the API would refuse (a device recipient, a mapping without
 *   `templateSetCode`, template data outside the RFC bounds, a recipient id
 *   that is not a visible-ASCII header value) is `rejected` without a call.
 */
export function createAitFunctionalMessageDeliveryProvider(
  options: CreateAitFunctionalMessageDeliveryProviderOptions,
): AitFunctionalMessageDeliveryProvider {
  if (options.recipientKey !== 'toss-user' && options.recipientKey !== 'anonymous') {
    throw new TypeError("recipientKey must be 'toss-user' or 'anonymous'.");
  }
  const recipientHeader = options.recipientKey === 'anonymous' ? 'x-anon-key' : 'x-toss-user-key';
  const url = new URL(
    aitFunctionalMessagePath,
    normalizeBaseUrl(options.baseUrl ?? defaultAitFunctionalMessageBaseUrl),
  ).href;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const agreementErrorCodes = new Set(options.agreementErrorCodes ?? []);
  const recipientErrorCodes = new Set(options.recipientErrorCodes ?? []);
  const agreementFailReasons = new Set(
    (options.agreementFailReasons ?? []).map((reason) => reason.trim()),
  );

  const classifyFailCode = (code: string, status: number): AitFunctionalMessageAnswer => {
    if (code === rateLimitedErrorCode) {
      return { status: 'rate-limited', providerCode: code };
    }
    if (agreementErrorCodes.has(code)) {
      return { status: 'rejected', reason: 'agreement', providerCode: code };
    }
    if (recipientErrorCodes.has(code)) {
      return { status: 'rejected', reason: 'recipient', providerCode: code };
    }
    if (configurationErrorCodes.has(code) || refusedRequestStatuses.has(status)) {
      return { status: 'rejected', reason: 'configuration', providerCode: code };
    }
    // An undocumented code on another status proves nothing either way.
    return status === 200
      ? { status: 'rejected', reason: 'recipient', providerCode: code }
      : { status: 'ambiguous', providerCode: code };
  };

  return {
    id: aitFunctionalMessageProviderId,
    entry: referenceNotificationProviders['apps-in-toss'],
    async send(request) {
      const templateSetCode = request.topic.mapping?.['templateSetCode'];
      if (typeof templateSetCode !== 'string' || !isIdentifier(templateSetCode)) {
        return { status: 'rejected', reason: 'configuration' };
      }
      const context = request.templateData ?? {};
      if (notificationTemplateDataIssue(context) !== undefined) {
        return { status: 'rejected', reason: 'configuration' };
      }
      const { recipient } = request;
      if (recipient.kind !== 'platform-user') {
        return { status: 'rejected', reason: 'configuration' };
      }
      if (!isHeaderValue(recipient.id)) {
        return { status: 'rejected', reason: 'recipient' };
      }

      const response = await post({
        mtls: options.mtls,
        url,
        headers: { [recipientHeader]: recipient.id },
        body: { templateSetCode, context },
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (response.kind === 'failed') {
        return { status: 'ambiguous', providerCode: response.reason };
      }
      const { status, body } = response;
      if (status >= 500 || status === 408 || status === 425) {
        return { status: 'ambiguous', ...providerCodeOf(body) };
      }
      if (status === 429) {
        // Throttled at the HTTP layer: nothing was sent, whatever the body says.
        const error = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
        const retryAfterSeconds = retryAfterOf(error, response.retryAfter);
        return {
          status: 'rate-limited',
          ...providerCodeOf(body),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        };
      }
      const resultType = isRecord(body) ? body['resultType'] : undefined;
      if (resultType === 'SUCCESS') {
        return status >= 200 && status < 300
          ? readSuccess(isRecord(body) ? body['success'] : undefined, agreementFailReasons)
          : { status: 'ambiguous', providerCode: 'SUCCESS' };
      }
      if (resultType === 'FAIL' && isRecord(body)) {
        const error = isRecord(body['error']) ? body['error'] : undefined;
        const code = errorCodeOf(error?.['errorCode']);
        if (code === undefined) {
          return { status: 'ambiguous', providerCode: 'FAIL' };
        }
        const answer = classifyFailCode(code, status);
        if (answer.status === 'rate-limited') {
          const retryAfterSeconds = retryAfterOf(error, response.retryAfter);
          return retryAfterSeconds === undefined ? answer : { ...answer, retryAfterSeconds };
        }
        return answer;
      }
      if (typeof resultType === 'string' && ambiguousResultTypes.has(resultType)) {
        return { status: 'ambiguous', providerCode: resultType };
      }
      if (refusedRequestStatuses.has(status)) {
        return { status: 'rejected', reason: 'configuration', ...providerCodeOf(body) };
      }
      // Any other answer without a readable result proves nothing either way.
      return { status: 'ambiguous', ...providerCodeOf(body) };
    },
  };
}

function readSuccess(
  success: unknown,
  agreementFailReasons: ReadonlySet<string>,
): AitFunctionalMessageAnswer {
  if (!isRecord(success)) {
    return { status: 'ambiguous', providerCode: 'SUCCESS' };
  }
  const messageCount = success['msgCount'];
  const detail = success['detail'];
  const fail = success['fail'];
  if (!isCount(messageCount)) {
    return { status: 'ambiguous', providerCode: 'SUCCESS' };
  }
  const channelOf = (field: string): AitFunctionalMessageChannelResult => ({
    sent: readContents(isRecord(detail) ? detail[field] : undefined),
    failed: readContents(isRecord(fail) ? fail[field] : undefined),
  });
  const channels: AitFunctionalMessageChannelResults = {
    push: channelOf(channelFields.push),
    inbox: channelOf(channelFields.inbox),
    sms: channelOf(channelFields.sms),
    alimtalk: channelOf(channelFields.alimtalk),
    friendtalk: channelOf(channelFields.friendtalk),
  };
  const results = Object.values(channels);
  const firstSent = results.find((result) => result.sent.length > 0)?.sent[0];
  if (messageCount > 0 || firstSent !== undefined) {
    return {
      status: 'accepted',
      ...(firstSent === undefined ? {} : { providerMessageId: firstSent.contentId }),
      messageCount,
      channels,
    };
  }
  // Nothing reached any channel. One recipient per call, so the per-channel
  // failures are this recipient's; an agreement failure on any channel
  // decides, because the template itself was not agreed to.
  const agreement = results.some((result) =>
    result.failed.some((failure) =>
      failure.reachedFailReason !== undefined
      && agreementFailReasons.has(failure.reachedFailReason.trim())));
  return { status: 'rejected', reason: agreement ? 'agreement' : 'recipient', channels };
}

function readContents(
  input: unknown,
): { readonly contentId: string; readonly reachedFailReason?: string }[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const contents: { readonly contentId: string; readonly reachedFailReason?: string }[] = [];
  for (const item of input.slice(0, 64)) {
    if (!isRecord(item) || typeof item['contentId'] !== 'string') {
      continue;
    }
    const reason = item['reachedFailReason'];
    contents.push({
      contentId: item['contentId'].slice(0, 256),
      ...(typeof reason === 'string' ? { reachedFailReason: reason.slice(0, 1_024) } : {}),
    });
  }
  return contents;
}

type PartnerResponse =
  | {
      readonly kind: 'answered';
      readonly status: number;
      readonly body: unknown;
      readonly retryAfter: string | undefined;
    }
  /** Nothing proves whether the message went out. */
  | { readonly kind: 'failed'; readonly reason: 'TIMEOUT' | 'ABORTED' | 'TRANSPORT_ERROR' };

/**
 * One POST over the mTLS fetcher, bounded in time (the body read included)
 * and size. A body that is too large or not UTF-8 reads as no body, so the
 * status decides. The request's connection is released when the call ends.
 */
async function post(input: {
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<PartnerResponse> {
  // A function, so the check reads the signal at each call rather than once.
  const callerAborted = (): boolean => input.signal?.aborted === true;
  if (callerAborted()) {
    // An aborted caller sends nothing; the answer is still the ambiguous one.
    return { kind: 'failed', reason: 'ABORTED' };
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const response = await input.mtls.fetch(input.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...input.headers,
      },
      body: JSON.stringify(input.body),
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await readBoundedText(response);
    let body: unknown;
    if (text !== undefined && text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = undefined;
      }
    }
    return {
      kind: 'answered',
      status: response.status,
      body,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    };
  } catch {
    if (timedOut) {
      return { kind: 'failed', reason: 'TIMEOUT' };
    }
    return { kind: 'failed', reason: callerAborted() ? 'ABORTED' : 'TRANSPORT_ERROR' };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    // Frees a connection whose body was not read to the end.
    controller.abort();
  }
}

/** The body as UTF-8 text, or `undefined` when it is larger than 256 KiB or not UTF-8. */
async function readBoundedText(response: Response): Promise<string | undefined> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > maximumResponseBodyBytes
  ) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      length += chunk.value.byteLength;
      if (length > maximumResponseBodyBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A string code, or a finite number read as its digits; anything else is no code. */
function errorCodeOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 && value.length <= 128 ? value : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function providerCodeOf(body: unknown): { readonly providerCode?: string } {
  if (!isRecord(body)) {
    return {};
  }
  const error = isRecord(body['error']) ? body['error'] : undefined;
  const code = errorCodeOf(error?.['errorCode']);
  if (code !== undefined) {
    return { providerCode: code };
  }
  const resultType = body['resultType'];
  return typeof resultType === 'string' && resultType.length > 0
    ? { providerCode: resultType.slice(0, 128) }
    : {};
}

/** The body's `error.data.retryAfterSeconds` when it is a usable delay, else the `Retry-After` header's. */
function retryAfterOf(
  error: Readonly<Record<string, unknown>> | undefined,
  header: string | undefined,
): number | undefined {
  const data = isRecord(error?.['data']) ? error['data'] : undefined;
  return positiveSeconds(data?.['retryAfterSeconds']) ?? positiveSeconds(header);
}

/** A positive number of seconds, rounded up and capped at a day, from a number or a decimal string. */
function positiveSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), maximumAitFunctionalMessageRetryAfterSeconds)
    : undefined;
}

function isIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= maximumIdentifierLength
    && value.trim() === value
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

/** A value a `fetch` header accepts as is: visible ASCII, at most 2,048 characters. */
function isHeaderValue(value: string): boolean {
  return value.length <= maximumIdentifierLength && /^[\x21-\x7e]+$/u.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A credential-free HTTPS base URL ending in `/`, as the partner API client requires. */
function normalizeBaseUrl(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new TypeError(
      'The Apps in Toss partner API baseUrl must be a credential-free HTTPS URL.',
    );
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url.href;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) {
    return defaultAitFunctionalMessageTimeoutMs;
  }
  if (!Number.isFinite(value) || value < 1 || value > maximumTimeoutMs) {
    throw new RangeError(
      'The Apps in Toss functional message timeout must be between 1 and 60000 ms.',
    );
  }
  return value;
}
