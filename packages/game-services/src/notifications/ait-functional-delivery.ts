import {
  notificationTemplateDataIssue,
  referenceNotificationProviders,
  type NotificationDeliveryProviderEntry,
  type NotificationProviderId,
  type NotificationTemplateData,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import type {
  AppsInTossMessageRecipient,
  AppsInTossMutualTlsFetcher,
} from '../apps-in-toss-partner-api.js';

/**
 * Apps in Toss functional-message delivery provider (notifications RFC
 * "Delivery providers -> Apps in Toss"). It sends one `send-message` call per
 * recipient over the partner API's mTLS client certificate and answers one of
 * the RFC's five provider answers ("Provider answers"). The backend's policy
 * gate decides whether to call it and maps each answer to a delivery outcome;
 * this module keeps no ledger, makes no gate decision, and uses only `fetch`
 * through the injected mTLS fetcher, so it runs on Cloudflare Workers.
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

export const defaultAitFunctionalMessageBaseUrl = 'https://apps-in-toss-api.toss.im';

export const defaultAitFunctionalMessageTimeoutMs = 10_000;

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
 * are platform users, not device addresses. `hostCode` keeps the partner
 * API's `errorCode` or `resultType` for diagnostics, and `channels` the
 * per-channel lists of a `SUCCESS` answer.
 */
export type AitFunctionalMessageAnswer =
  | {
      readonly status: 'accepted';
      readonly messageCount: number;
      readonly channels: AitFunctionalMessageChannelResults;
    }
  | {
      readonly status: 'rate-limited';
      readonly retryAfterSeconds?: number;
      readonly hostCode?: string;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AitFunctionalMessageRejection;
      readonly hostCode?: string;
      readonly channels?: AitFunctionalMessageChannelResults;
    }
  | { readonly status: 'ambiguous'; readonly hostCode?: string };

export interface AitFunctionalMessageDeliveryRequest {
  /** Resolved by the backend from the player's authenticated Apps in Toss identity, never from the client. */
  readonly recipient: AppsInTossMessageRecipient;
  /** The topic as declared for this provider: its mapping carries `templateSetCode`. */
  readonly topic: Pick<NotificationTopicDeclaration, 'id' | 'mapping'>;
  /** The template's `context` values. */
  readonly templateData?: NotificationTemplateData;
  readonly signal?: AbortSignal;
}

export interface CreateAitFunctionalMessageDeliveryProviderOptions {
  /** The partner API mTLS client, such as a Workers mTLS certificate binding (`env.BINDING`). */
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** `FAIL` error codes that mean the recipient has not agreed to the template. */
  readonly agreementErrorCodes?: readonly string[];
  /** `reachedFailReason` texts that mean the recipient has not agreed to the template. */
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
const channelFields: Readonly<Record<AitFunctionalMessageChannel, string>> = {
  push: 'sentPush',
  inbox: 'sentInbox',
  sms: 'sentSms',
  alimtalk: 'sentAlimtalk',
  friendtalk: 'sentFriendtalk',
};
const maximumResponseBodyBytes = 256 * 1_024;
const maximumIdentifierLength = 2_048;

/**
 * Creates the provider. `send` never throws for a partner API answer: every
 * HTTP answer, transport failure, and timeout maps to a provider answer.
 *
 * - `SUCCESS` with at least one message sent on any channel is `accepted`.
 *   With none sent, the per-channel `fail` lists decide: `rejected` with
 *   reason `agreement` when a failure's `reachedFailReason` is one of
 *   `agreementFailReasons`, otherwise `recipient`.
 * - `FAIL` 4095 is `rate-limited` with `retryAfterSeconds`; 5004, 4034, and
 *   4010 are `rejected` with reason `configuration`; a code in
 *   `agreementErrorCodes` or `recipientErrorCodes` is `rejected` with that
 *   reason; any other code is `rejected` with reason `recipient` on HTTP 200
 *   and `configuration` on HTTP 400, 401, or 403.
 * - `HTTP_TIMEOUT`, `NETWORK_ERROR`, `EXECUTION_FAIL`, `INTERRUPTED`, and
 *   `INTERNAL_ERROR`, any HTTP 5xx, a transport failure, a timeout, and an
 *   answer that cannot be read are `ambiguous`: the claim stays and the
 *   scheduler replays after the lease.
 * - HTTP 429 without a business error is `rate-limited` (`Retry-After` in
 *   seconds when present); other HTTP 4xx answers are `rejected` with reason
 *   `configuration`.
 * - A request the API would refuse (a mapping without `templateSetCode`,
 *   template data outside the RFC bounds, an invalid recipient key) is
 *   `rejected` without a call.
 */
export function createAitFunctionalMessageDeliveryProvider(
  options: CreateAitFunctionalMessageDeliveryProviderOptions,
): AitFunctionalMessageDeliveryProvider {
  const url = new URL(
    aitFunctionalMessagePath,
    withTrailingSlash(options.baseUrl ?? defaultAitFunctionalMessageBaseUrl),
  ).href;
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const agreementErrorCodes = new Set(options.agreementErrorCodes ?? []);
  const recipientErrorCodes = new Set(options.recipientErrorCodes ?? []);
  const agreementFailReasons = new Set(options.agreementFailReasons ?? []);

  const classifyFailCode = (code: string, status: number): AitFunctionalMessageAnswer => {
    if (code === rateLimitedErrorCode) {
      return { status: 'rate-limited', hostCode: code };
    }
    if (agreementErrorCodes.has(code)) {
      return { status: 'rejected', reason: 'agreement', hostCode: code };
    }
    if (recipientErrorCodes.has(code)) {
      return { status: 'rejected', reason: 'recipient', hostCode: code };
    }
    if (configurationErrorCodes.has(code) || status !== 200) {
      return { status: 'rejected', reason: 'configuration', hostCode: code };
    }
    return { status: 'rejected', reason: 'recipient', hostCode: code };
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
      if (
        (recipient.type !== 'toss-user' && recipient.type !== 'anonymous')
        || !isIdentifier(recipient.key)
      ) {
        return { status: 'rejected', reason: 'recipient' };
      }

      const response = await post({
        mtls: options.mtls,
        url,
        headers: recipient.type === 'anonymous'
          ? { 'x-anon-key': recipient.key }
          : { 'x-toss-user-key': recipient.key },
        body: { templateSetCode, context },
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (response === undefined || response.status >= 500) {
        return { status: 'ambiguous', ...hostCodeOf(response?.body) };
      }
      const body = response.body;
      const resultType = isRecord(body) ? body['resultType'] : undefined;
      if (resultType === 'SUCCESS' && response.status >= 200 && response.status < 300) {
        return readSuccess(isRecord(body) ? body['success'] : undefined, agreementFailReasons);
      }
      if (resultType === 'FAIL' && isRecord(body)) {
        const error = isRecord(body['error']) ? body['error'] : undefined;
        const code = typeof error?.['errorCode'] === 'string'
          ? error['errorCode']
          : String(error?.['errorCode'] ?? '');
        const answer = classifyFailCode(code, response.status);
        if (answer.status === 'rate-limited') {
          const retryAfterSeconds = positiveSeconds(
            isRecord(error?.['data']) ? error['data']['retryAfterSeconds'] : undefined,
          );
          return retryAfterSeconds === undefined ? answer : { ...answer, retryAfterSeconds };
        }
        return answer;
      }
      if (typeof resultType === 'string' && ambiguousResultTypes.has(resultType)) {
        return { status: 'ambiguous', hostCode: resultType };
      }
      if (response.status === 429) {
        const retryAfterSeconds = positiveSeconds(response.retryAfter);
        return retryAfterSeconds === undefined
          ? { status: 'rate-limited' }
          : { status: 'rate-limited', retryAfterSeconds };
      }
      if (response.status >= 400) {
        return { status: 'rejected', reason: 'configuration', ...hostCodeOf(body) };
      }
      // A 2xx or 3xx answer without a readable result: nothing proves either way.
      return { status: 'ambiguous', ...hostCodeOf(body) };
    },
  };
}

function readSuccess(
  success: unknown,
  agreementFailReasons: ReadonlySet<string>,
): AitFunctionalMessageAnswer {
  if (!isRecord(success)) {
    return { status: 'ambiguous', hostCode: 'SUCCESS' };
  }
  const messageCount = success['msgCount'];
  const detail = success['detail'];
  const fail = success['fail'];
  if (!isCount(messageCount)) {
    return { status: 'ambiguous', hostCode: 'SUCCESS' };
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
  if (messageCount > 0 || results.some((result) => result.sent.length > 0)) {
    return { status: 'accepted', messageCount, channels };
  }
  // Nothing reached any channel. One recipient per call, so the per-channel
  // failures are this recipient's; an agreement failure on any channel
  // decides, because the template itself was not agreed to.
  const agreement = results.some((result) =>
    result.failed.some((failure) =>
      failure.reachedFailReason !== undefined && agreementFailReasons.has(failure.reachedFailReason)));
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

interface PartnerResponse {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | undefined;
}

/**
 * One POST over the mTLS fetcher, bounded in time and size. `undefined` when
 * the call failed in transport, timed out, was aborted, or its answer could
 * not be read: none of these proves whether the message went out.
 */
async function post(input: {
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<PartnerResponse | undefined> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input.signal?.aborted === true) {
    // An aborted caller sends nothing; the answer is still the ambiguous one.
    return undefined;
  }
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, input.timeoutMs);
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
      status: response.status,
      body,
      retryAfter: response.headers.get('retry-after') ?? undefined,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

/** The body as UTF-8 text, or `undefined` when it is larger than 256 KiB or not UTF-8. */
async function readBoundedText(response: Response): Promise<string | undefined> {
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

function hostCodeOf(body: unknown): { readonly hostCode?: string } {
  if (!isRecord(body)) {
    return {};
  }
  const error = isRecord(body['error']) ? body['error'] : undefined;
  const code = error?.['errorCode'];
  if (typeof code === 'string' && code.length > 0) {
    return { hostCode: code.slice(0, 128) };
  }
  const resultType = body['resultType'];
  return typeof resultType === 'string' && resultType.length > 0
    ? { hostCode: resultType.slice(0, 128) }
    : {};
}

/** A positive number of seconds, rounded up, from a number or a decimal string. */
function positiveSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : undefined;
}

function isIdentifier(value: string): boolean {
  return value.length > 0
    && value.length <= maximumIdentifierLength
    && value.trim() === value
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) {
    return defaultAitFunctionalMessageTimeoutMs;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('The Apps in Toss functional message timeout must be a positive number.');
  }
  return value;
}
