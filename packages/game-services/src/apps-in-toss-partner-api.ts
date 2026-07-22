import type { NotificationTemplateData } from './notification-delivery';

export const appsInTossPartnerApiBaseUrl = 'https://apps-in-toss-api.toss.im';
export const defaultAppsInTossPartnerApiTimeoutMs = 10_000;

const verifyAnonymousKeyPath = '/api-partner/v1/apps-in-toss/users/anon-key/verify';
const sendFunctionalMessagePath = '/api-partner/v1/apps-in-toss/messenger/send-message';
const maximumResponseBodyBytes = 256 * 1_024;

/** Compatible with a Cloudflare mTLS certificate binding (`env.BINDING.fetch`). */
export interface AppsInTossMutualTlsFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export type AppsInTossMessageRecipient =
  | { readonly type: 'anonymous'; readonly key: string }
  | { readonly type: 'toss-user'; readonly key: string };

export interface SendAppsInTossFunctionalMessageInput {
  readonly recipient: AppsInTossMessageRecipient;
  readonly templateSetCode: string;
  readonly context: NotificationTemplateData;
  readonly signal?: AbortSignal;
}

export interface AppsInTossFunctionalMessageResult {
  readonly messageCount: number;
  readonly sentPushCount: number;
  readonly sentInboxCount: number;
  readonly sentSmsCount: number;
  readonly sentAlimtalkCount: number;
  readonly sentFriendtalkCount: number;
  readonly contentIds: readonly string[];
}

export interface AppsInTossPartnerApiClient {
  verifyAnonymousKey(input: {
    readonly anonymousKey: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
  sendFunctionalMessage(
    input: SendAppsInTossFunctionalMessageInput,
  ): Promise<AppsInTossFunctionalMessageResult>;
}

export interface CreateAppsInTossPartnerApiClientInput {
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class AppsInTossPartnerApiError extends Error {
  override readonly name = 'AppsInTossPartnerApiError';

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function createAppsInTossPartnerApiClient(
  input: CreateAppsInTossPartnerApiClientInput,
): AppsInTossPartnerApiClient {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? appsInTossPartnerApiBaseUrl);
  const timeoutMs = normalizeTimeout(input.timeoutMs);

  return {
    async verifyAnonymousKey(request) {
      const anonymousKey = normalizeIdentifier(request.anonymousKey, 'anonymousKey');
      const response = await postJson({
        mtls: input.mtls,
        url: new URL(verifyAnonymousKeyPath, baseUrl).href,
        headers: { 'x-anon-key': anonymousKey },
        body: undefined,
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      if (response.status === 401) {
        return false;
      }
      const envelope = requireSuccessEnvelope(response);
      if (envelope.success !== 'true') {
        throw new AppsInTossPartnerApiError(
          'Apps in Toss returned an invalid anonymous-key verification response.',
          response.status,
        );
      }
      return true;
    },

    async sendFunctionalMessage(request) {
      const recipient = normalizeRecipient(request.recipient);
      const templateSetCode = normalizeIdentifier(
        request.templateSetCode,
        'templateSetCode',
      );
      const response = await postJson({
        mtls: input.mtls,
        url: new URL(sendFunctionalMessagePath, baseUrl).href,
        headers: recipient.type === 'anonymous'
          ? { 'x-anon-key': recipient.key }
          : { 'x-toss-user-key': recipient.key },
        body: {
          templateSetCode,
          context: normalizeContext(request.context),
        },
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const envelope = requireSuccessEnvelope(response);
      return parseFunctionalMessageResult(envelope.success, response.status);
    },
  };
}

interface PostJsonInput {
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface PartnerApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

async function postJson(input: PostJsonInput): Promise<PartnerApiResponse> {
  const timeout = createTimeoutSignal(input.signal, input.timeoutMs);
  try {
    const requestBody = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers = new Headers({
      accept: 'application/json',
      ...input.headers,
    });
    if (requestBody !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const response = await input.mtls.fetch(input.url, {
      method: 'POST',
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: timeout.signal,
    });
    const text = await readBoundedResponseText(response);

    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text) as unknown;
    } catch {
      throw new AppsInTossPartnerApiError(
        'Apps in Toss returned a non-JSON response.',
        response.status,
      );
    }
    return { status: response.status, ok: response.ok, body };
  } finally {
    timeout.cleanup();
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > maximumResponseBodyBytes
  ) {
    throw responseTooLarge(response.status);
  }
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumResponseBodyBytes) {
        await reader.cancel().catch(() => {});
        throw responseTooLarge(response.status);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppsInTossPartnerApiError(
      'Apps in Toss returned a non-UTF-8 response.',
      response.status,
    );
  }
}

function responseTooLarge(status: number): AppsInTossPartnerApiError {
  return new AppsInTossPartnerApiError(
    'Apps in Toss response exceeded the maximum accepted size.',
    status,
  );
}

function requireSuccessEnvelope(
  response: PartnerApiResponse,
): Readonly<Record<string, unknown>> {
  if (!isRecord(response.body)) {
    throw new AppsInTossPartnerApiError(
      'Apps in Toss returned an invalid response envelope.',
      response.status,
    );
  }
  if (response.ok && response.body.resultType === 'SUCCESS') {
    return response.body;
  }

  const error = isRecord(response.body.error) ? response.body.error : undefined;
  const code = typeof error?.errorCode === 'string' ? error.errorCode : undefined;
  const reason = typeof error?.reason === 'string'
    ? error.reason.slice(0, 1_024)
    : 'Apps in Toss partner API request failed.';
  throw new AppsInTossPartnerApiError(reason, response.status, code);
}

function parseFunctionalMessageResult(
  input: unknown,
  status: number,
): AppsInTossFunctionalMessageResult {
  if (!isRecord(input)) {
    throw new AppsInTossPartnerApiError('Apps in Toss returned an invalid message result.', status);
  }

  return {
    messageCount: requireCount(input.msgCount, 'msgCount', status),
    sentPushCount: requireCount(input.sentPushCount, 'sentPushCount', status),
    sentInboxCount: requireCount(input.sentInboxCount, 'sentInboxCount', status),
    sentSmsCount: requireCount(input.sentSmsCount, 'sentSmsCount', status),
    sentAlimtalkCount: requireCount(input.sentAlimtalkCount, 'sentAlimtalkCount', status),
    sentFriendtalkCount: requireCount(
      input.sentFriendtalkCount,
      'sentFriendtalkCount',
      status,
    ),
    contentIds: readContentIds(input.detail),
  };
}

function readContentIds(detail: unknown): readonly string[] {
  if (!isRecord(detail)) {
    return [];
  }
  const ids = new Set<string>();
  for (const channel of ['sentPush', 'sentInbox', 'sentSms', 'sentAlimtalk', 'sentFriendtalk']) {
    const entries = detail[channel];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.contentId === 'string' && entry.contentId.length > 0) {
        ids.add(entry.contentId);
      }
    }
  }
  return [...ids];
}

function requireCount(value: unknown, field: string, status: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AppsInTossPartnerApiError(`Apps in Toss returned an invalid ${field}.`, status);
  }
  return value as number;
}

function normalizeRecipient(input: AppsInTossMessageRecipient): AppsInTossMessageRecipient {
  if (input.type !== 'anonymous' && input.type !== 'toss-user') {
    throw new TypeError('AIT message recipient type is invalid.');
  }
  return { type: input.type, key: normalizeIdentifier(input.key, 'recipient.key') };
}

function normalizeContext(input: NotificationTemplateData): NotificationTemplateData {
  const entries = Object.entries(input);
  if (entries.length > 128) {
    throw new TypeError('AIT message context cannot contain more than 128 values.');
  }
  const output = Object.create(null) as Record<string, string | number | boolean>;
  for (const [key, value] of entries) {
    const normalizedKey = normalizeIdentifier(key, 'context key');
    if (
      typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
    ) {
      throw new TypeError(`AIT message context value is invalid: ${normalizedKey}`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`AIT message context number is invalid: ${normalizedKey}`);
    }
    output[normalizedKey] = value;
  }
  return output;
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 2_048
    || /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new TypeError(`${field} must contain 1 to 2048 characters.`);
  }
  return normalized;
}

function normalizeBaseUrl(input: string): URL {
  const url = new URL(input);
  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new TypeError('AIT partner API baseUrl must be a credential-free HTTPS URL.');
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return url;
}

function normalizeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? defaultAppsInTossPartnerApiTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError('AIT partner API timeoutMs must be between 1 and 60000.');
  }
  return timeoutMs;
}

function createTimeoutSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  const abortFromUpstream = (): void => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) {
    abortFromUpstream();
  } else {
    upstream?.addEventListener('abort', abortFromUpstream, { once: true });
  }
  const timer = globalThis.setTimeout(
    () => controller.abort(new Error('Apps in Toss partner API request timed out.')),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    cleanup() {
      globalThis.clearTimeout(timer);
      upstream?.removeEventListener('abort', abortFromUpstream);
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
