import { exchangeAnonAuthCode } from '@ait-kit/api-core';
import type { NotificationTemplateData } from './notification-delivery.js';

export const appsInTossPartnerApiBaseUrl = 'https://apps-in-toss-api.toss.im';
export const defaultAppsInTossPartnerApiTimeoutMs = 10_000;

const verifyAnonymousKeyPath = 'api-partner/v1/apps-in-toss/users/anon-key/verify';
const sendFunctionalMessagePath = 'api-partner/v1/apps-in-toss/messenger/send-message';
const exchangeLoginAuthorizationCodePath =
  'api-partner/v1/apps-in-toss/user/oauth2/generate-token';
const getLoginUserPath = 'api-partner/v1/apps-in-toss/user/oauth2/login-me';
const getIapOrderStatusPath = 'api-partner/v1/apps-in-toss/order/get-order-status';
// Promotion (Toss points) calls, checked 2026-11-23 against
// https://developers-apps-in-toss.toss.im/api/promotion.md and the server
// section of https://developers-apps-in-toss.toss.im/documentation/common/growth/promotion.md.
const issuePromotionKeyPath = 'api-partner/v1/apps-in-toss/promotion/execute-promotion/get-key';
const executePromotionPath = 'api-partner/v1/apps-in-toss/promotion/execute-promotion';
const getPromotionExecutionResultPath = 'api-partner/v1/apps-in-toss/promotion/execution-result';
/** `execution-result`'s business error for a key with no payment ("리워드 지급내역을 찾을 수 없어요"). */
const promotionExecutionNotFoundErrorCode = '4111';
const maximumPromotionKeyLength = 4_096;
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

/** The source environment returned by the Apps in Toss login SDK. */
export type AppsInTossLoginReferrer = 'DEFAULT' | 'SANDBOX';

/**
 * Short-lived OAuth token material returned by the partner API.
 *
 * Callers should use this only to immediately resolve a login identity or
 * securely persist it in a dedicated credential store. It must never be sent
 * back to a game client.
 */
export interface AppsInTossLoginToken {
  readonly tokenType: 'bearer';
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scope: string;
}

/** App-scoped user identity returned by the Apps in Toss login API. */
export interface AppsInTossLoginUser {
  /** Serialized because the documented API returns a numeric user key. */
  readonly userKey: string;
  readonly scope: string;
}

export type AppsInTossIapOrderStatus =
  | 'PURCHASED'
  | 'PAYMENT_COMPLETED'
  | 'FAILED'
  | 'REFUNDED'
  | 'ORDER_IN_PROGRESS'
  | 'NOT_FOUND'
  | 'MINIAPP_MISMATCH'
  | 'ERROR';

/** Authoritative order status returned from the mTLS Apps in Toss partner API. */
export interface AppsInTossIapOrderStatusResult {
  readonly orderId: string;
  readonly sku: string;
  readonly statusDeterminedAt: string;
  readonly status: AppsInTossIapOrderStatus;
  readonly reason?: string;
}

/**
 * Who a promotion pays, sent as the one recipient header the promotion API
 * takes: a Toss Login `userKey` (`x-toss-user-key`) or a
 * `User.getAnonymousKey` hash (`x-anon-key`). Resolve it on the server from
 * the player's authenticated identity, never from a key a game client sent.
 */
export type AppsInTossPromotionRecipient = AppsInTossMessageRecipient;

/**
 * A promotion payment key. It is opaque (documented as base64), valid for
 * one hour after it was issued, and pays at most once: executing a used key
 * answers business error `4113` instead of paying again.
 */
export interface AppsInTossPromotionKey {
  readonly key: string;
}

export interface IssueAppsInTossPromotionKeyInput {
  readonly recipient: AppsInTossPromotionRecipient;
  readonly signal?: AbortSignal;
}

export interface ExecuteAppsInTossPromotionInput {
  /** The recipient the key was issued to. */
  readonly recipient: AppsInTossPromotionRecipient;
  /** The console's promotion code. Its `TEST_` form is the console test, which pays no points. */
  readonly promotionCode: string;
  /** The key issued for this grant, stored with the grant before the first call. */
  readonly key: string;
  /** Toss points to pay: a positive safe integer. */
  readonly amount: number;
  readonly signal?: AbortSignal;
}

export interface GetAppsInTossPromotionExecutionResultInput {
  readonly recipient: AppsInTossPromotionRecipient;
  readonly promotionCode: string;
  readonly key: string;
  readonly signal?: AbortSignal;
}

/**
 * A key's payment as `execution-result` reports it. `SUCCESS`: paid.
 * `PENDING`: accepted and still being processed. `FAILED`: the payment
 * failed and the budget it used was rolled back. `NOT_FOUND`: business error
 * `4111`, no payment is recorded for the key yet; an execute call that is
 * still in progress at Toss may not be recorded.
 */
export type AppsInTossPromotionExecutionStatus = 'SUCCESS' | 'PENDING' | 'FAILED' | 'NOT_FOUND';

export interface AppsInTossPromotionExecutionResult {
  readonly status: AppsInTossPromotionExecutionStatus;
}

export interface AppsInTossPartnerApiClient {
  /** Authenticate with a fresh SDK 3.6 code; key existence checks are not login. */
  exchangeAnonymousAuthorizationCode(input: {
    readonly code: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly anonymousKey: string }>;
  verifyAnonymousKey(input: {
    readonly anonymousKey: string;
    readonly signal?: AbortSignal;
  }): Promise<boolean>;
  sendFunctionalMessage(
    input: SendAppsInTossFunctionalMessageInput,
  ): Promise<AppsInTossFunctionalMessageResult>;
  exchangeLoginAuthorizationCode(input: {
    readonly authorizationCode: string;
    readonly referrer: AppsInTossLoginReferrer;
    readonly signal?: AbortSignal;
  }): Promise<AppsInTossLoginToken>;
  getLoginUser(input: {
    readonly accessToken: string;
    readonly signal?: AbortSignal;
  }): Promise<AppsInTossLoginUser>;
  getIapOrderStatus(input: {
    readonly orderId: string;
    /**
     * Optional user key resolved through Apps in Toss login. Supplying it
     * narrows the lookup to the same authenticated user; the official API also
     * supports an order-id-only lookup when a game does not require login.
     */
    readonly tossUserKey?: string;
    readonly signal?: AbortSignal;
  }): Promise<AppsInTossIapOrderStatusResult>;
  /**
   * Issues a new promotion payment key for one recipient. Every call issues
   * another key: store the key with its grant before `executePromotion`, and
   * never issue a second key for a grant whose first key may have paid.
   */
  issuePromotionKey(input: IssueAppsInTossPromotionKeyInput): Promise<AppsInTossPromotionKey>;
  /**
   * Pays `amount` Toss points with a stored key and resolves when Toss
   * accepted the payment, which may still be `PENDING`. A rejection (a
   * timeout, an abort, an HTTP or business error such as `4113`) does not
   * tell whether the key paid: settle the grant with
   * `getPromotionExecutionResult`, and execute again only with the same key,
   * once the earlier call can no longer be in progress at Toss.
   */
  executePromotion(input: ExecuteAppsInTossPromotionInput): Promise<AppsInTossPromotionKey>;
  /** Reads a key's payment: the answer that settles a grant. */
  getPromotionExecutionResult(
    input: GetAppsInTossPromotionExecutionResultInput,
  ): Promise<AppsInTossPromotionExecutionResult>;
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
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function createAppsInTossPartnerApiClient(
  input: CreateAppsInTossPartnerApiClientInput,
): AppsInTossPartnerApiClient {
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? appsInTossPartnerApiBaseUrl);
  const timeoutMs = normalizeTimeout(input.timeoutMs);

  return {
    async exchangeAnonymousAuthorizationCode(request) {
      const code = normalizeOpaqueValue(request.code, 'code', 4096);
      const timeout = createTimeoutSignal(request.signal, timeoutMs);
      try {
        const result = await exchangeAnonAuthCode({ code }, {
          mode: 'forward',
          upstreamBaseUrl: baseUrl.href,
          signal: timeout.signal,
          mtlsClient: {
            async request(url, init) {
              // ait-kit endpoints are origin-relative; retain this client's configured proxy prefix.
              const upstream = new URL(url);
              const target = new URL(upstream.pathname.slice(1) + upstream.search, baseUrl);
              // Older workerd rejects redirect: 'error'; manual keeps codes on this origin.
              // ait-kit rejects every non-2xx response, including redirects with SUCCESS bodies.
              const response = await input.mtls.fetch(target.href, { ...init, redirect: 'manual' });
              const text = await readBoundedResponseText(response);
              return new Response(text || null, { status: response.status, headers: response.headers });
            },
          },
        });
        if (timeout.signal.aborted) {
          throw normalizeTransportError(undefined, request.signal, timeout.signal);
        }
        if (!result.ok) {
          throw new AppsInTossPartnerApiError(
            'Apps in Toss anonymous authentication failed.',
            result.upstreamStatus ?? 0,
            result.error,
          );
        }
        return { anonymousKey: result.anonKey };
      } finally {
        timeout.cleanup();
      }
    },
    async verifyAnonymousKey(request) {
      const anonymousKey = normalizeIdentifier(request.anonymousKey, 'anonymousKey');
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
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
      // The OpenAPI schema uses a boolean while older Apps in Toss examples use
      // strings. Both false forms are ordinary rejections; every other shape
      // remains malformed and fails closed below.
      if (envelope.success === true || envelope.success === 'true') {
        return true;
      }
      if (envelope.success === false || envelope.success === 'false') {
        return false;
      }
      throw new AppsInTossPartnerApiError(
        'Apps in Toss returned an invalid anonymous-key verification response.',
        response.status,
      );
    },

    async sendFunctionalMessage(request) {
      const recipient = normalizeRecipient(request.recipient);
      const templateSetCode = normalizeIdentifier(
        request.templateSetCode,
        'templateSetCode',
      );
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
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

    async exchangeLoginAuthorizationCode(request) {
      const authorizationCode = normalizeIdentifier(
        request.authorizationCode,
        'authorizationCode',
      );
      const referrer = normalizeLoginReferrer(request.referrer);
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
        url: new URL(exchangeLoginAuthorizationCodePath, baseUrl).href,
        headers: {},
        body: { authorizationCode, referrer },
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const envelope = requireSuccessEnvelope(response);
      return parseLoginToken(envelope.success, response.status);
    },

    async getLoginUser(request) {
      const accessToken = normalizeOpaqueValue(
        request.accessToken,
        'accessToken',
        16_384,
      );
      const response = await requestJson({
        mtls: input.mtls,
        method: 'GET',
        url: new URL(getLoginUserPath, baseUrl).href,
        headers: { authorization: `Bearer ${accessToken}` },
        body: undefined,
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const envelope = requireSuccessEnvelope(response);
      return parseLoginUser(envelope.success, response.status);
    },

    async getIapOrderStatus(request) {
      const orderId = normalizeIdentifier(request.orderId, 'orderId');
      const tossUserKey = request.tossUserKey === undefined
        ? undefined
        : normalizeTossUserKey(request.tossUserKey, 'tossUserKey');
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
        url: new URL(getIapOrderStatusPath, baseUrl).href,
        headers: tossUserKey === undefined ? {} : { 'x-toss-user-key': tossUserKey },
        body: { orderId },
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const envelope = requireSuccessEnvelope(response);
      const orderStatus = parseIapOrderStatus(envelope.success, response.status);
      if (orderStatus.orderId !== orderId) {
        throw new AppsInTossPartnerApiError(
          'Apps in Toss returned a mismatched order id.',
          response.status,
        );
      }
      return orderStatus;
    },

    // The three promotion calls never retry on their own and never follow a
    // redirect, which would resend the recipient and the key to another URL.
    async issuePromotionKey(request) {
      const recipient = normalizeRecipient(request.recipient);
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
        url: new URL(issuePromotionKeyPath, baseUrl).href,
        headers: promotionRecipientHeaders(recipient),
        // The development guide documents no body for key issue.
        body: undefined,
        redirect: 'manual',
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const envelope = requireSuccessEnvelope(response);
      return { key: parsePromotionKey(envelope.success, response.status) };
    },

    async executePromotion(request) {
      const recipient = normalizeRecipient(request.recipient);
      const promotionCode = normalizeIdentifier(request.promotionCode, 'promotionCode');
      const key = normalizePromotionKey(request.key);
      const amount = normalizePromotionAmount(request.amount);
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
        url: new URL(executePromotionPath, baseUrl).href,
        headers: promotionRecipientHeaders(recipient),
        body: { promotionCode, key, amount },
        redirect: 'manual',
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const envelope = requireSuccessEnvelope(response);
      if (parsePromotionKey(envelope.success, response.status) !== key) {
        throw new AppsInTossPartnerApiError(
          'Apps in Toss returned a mismatched promotion key.',
          response.status,
        );
      }
      return { key };
    },

    async getPromotionExecutionResult(request) {
      const recipient = normalizeRecipient(request.recipient);
      const promotionCode = normalizeIdentifier(request.promotionCode, 'promotionCode');
      const key = normalizePromotionKey(request.key);
      const response = await requestJson({
        mtls: input.mtls,
        method: 'POST',
        url: new URL(getPromotionExecutionResultPath, baseUrl).href,
        headers: promotionRecipientHeaders(recipient),
        body: { promotionCode, key },
        redirect: 'manual',
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (isPromotionExecutionNotFound(response)) {
        return { status: 'NOT_FOUND' };
      }
      const envelope = requireSuccessEnvelope(response);
      return { status: parsePromotionExecutionStatus(envelope.success, response.status) };
    },
  };
}

interface JsonRequestInput {
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  /** `manual` returns a redirect as a failed answer instead of following it. */
  readonly redirect?: 'manual';
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface PartnerApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

async function requestJson(input: JsonRequestInput): Promise<PartnerApiResponse> {
  const timeout = createTimeoutSignal(input.signal, input.timeoutMs);
  try {
    // The documented anonymous-key verification request uses an empty body
    // while still declaring application/json. GET requests must omit a body.
    let requestBody: string | undefined;
    if (input.method === 'GET') {
      requestBody = undefined;
    } else if (input.body === undefined) {
      requestBody = '';
    } else {
      requestBody = JSON.stringify(input.body);
    }
    const headers = new Headers({
      accept: 'application/json',
      ...(input.method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...input.headers,
    });
    let response: Response;
    let text: string;
    try {
      response = await input.mtls.fetch(input.url, {
        method: input.method,
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
        ...(input.redirect === undefined ? {} : { redirect: input.redirect }),
        signal: timeout.signal,
      });
      text = await readBoundedResponseText(response);
    } catch (error) {
      throw normalizeTransportError(error, input.signal, timeout.signal);
    }

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

function normalizeTransportError(
  error: unknown,
  upstream: AbortSignal | undefined,
  effective: AbortSignal,
): AppsInTossPartnerApiError {
  if (error instanceof AppsInTossPartnerApiError) {
    return error;
  }
  if (effective.aborted && upstream?.aborted !== true) {
    return new AppsInTossPartnerApiError(
      'Apps in Toss partner API request timed out.',
      0,
      'TIMEOUT',
      { cause: error },
    );
  }
  if (upstream?.aborted === true) {
    return new AppsInTossPartnerApiError(
      'Apps in Toss partner API request was aborted.',
      0,
      'ABORTED',
      { cause: error },
    );
  }
  return new AppsInTossPartnerApiError(
    'Apps in Toss partner API transport failed.',
    0,
    'TRANSPORT_ERROR',
    { cause: error },
  );
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
    sentFriendtalkCount: requireCount(input.sentFriendtalkCount, 'sentFriendtalkCount', status),
    contentIds: readContentIds(input.detail),
  };
}

function parseLoginToken(input: unknown, status: number): AppsInTossLoginToken {
  if (!isRecord(input)) {
    throw new AppsInTossPartnerApiError('Apps in Toss returned an invalid login token.', status);
  }
  const tokenType = requireOpaqueValue(input.tokenType, 'tokenType', status, 64).toLowerCase();
  if (tokenType !== 'bearer') {
    throw new AppsInTossPartnerApiError('Apps in Toss returned an unsupported token type.', status);
  }

  return {
    tokenType,
    accessToken: requireOpaqueValue(input.accessToken, 'accessToken', status, 16_384),
    refreshToken: requireOpaqueValue(input.refreshToken, 'refreshToken', status, 16_384),
    expiresInSeconds: requirePositiveInteger(input.expiresIn, 'expiresIn', status),
    scope: requireOpaqueValue(input.scope, 'scope', status, 4_096),
  };
}

function parseLoginUser(input: unknown, status: number): AppsInTossLoginUser {
  if (!isRecord(input)) {
    throw new AppsInTossPartnerApiError('Apps in Toss returned an invalid login user.', status);
  }

  return {
    userKey: requireTossUserKey(input.userKey, 'userKey', status),
    scope: requireOpaqueValue(input.scope, 'scope', status, 4_096),
  };
}

function parseIapOrderStatus(
  input: unknown,
  status: number,
): AppsInTossIapOrderStatusResult {
  if (!isRecord(input)) {
    throw new AppsInTossPartnerApiError(
      'Apps in Toss returned an invalid IAP order status.',
      status,
    );
  }
  const orderStatus = requireOpaqueValue(input.status, 'status', status, 64);
  if (!appsInTossIapOrderStatuses.has(orderStatus as AppsInTossIapOrderStatus)) {
    throw new AppsInTossPartnerApiError(
      'Apps in Toss returned an unknown IAP order status.',
      status,
    );
  }
  const reason = input.reason;
  return {
    orderId: requireOpaqueValue(input.orderId, 'orderId', status, 2_048),
    sku: requireOpaqueValue(input.sku, 'sku', status, 2_048),
    statusDeterminedAt: requireOpaqueValue(
      input.statusDeterminedAt,
      'statusDeterminedAt',
      status,
      2_048,
    ),
    status: orderStatus as AppsInTossIapOrderStatus,
    ...(reason === undefined
      ? {}
      : { reason: requireOpaqueValue(reason, 'reason', status, 4_096) }),
  };
}

const appsInTossIapOrderStatuses = new Set<AppsInTossIapOrderStatus>([
  'PURCHASED',
  'PAYMENT_COMPLETED',
  'FAILED',
  'REFUNDED',
  'ORDER_IN_PROGRESS',
  'NOT_FOUND',
  'MINIAPP_MISMATCH',
  'ERROR',
]);

function promotionRecipientHeaders(
  recipient: AppsInTossPromotionRecipient,
): Readonly<Record<string, string>> {
  return recipient.type === 'anonymous'
    ? { 'x-anon-key': recipient.key }
    : { 'x-toss-user-key': recipient.key };
}

/** A key is sent exactly as it was issued: surrounding whitespace is refused, not trimmed. */
function normalizePromotionKey(value: string): string {
  return normalizeOpaqueValue(value, 'key', maximumPromotionKeyLength);
}

function normalizePromotionAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('amount must be a positive safe integer.');
  }
  return value;
}

function parsePromotionKey(input: unknown, status: number): string {
  if (!isRecord(input)) {
    throw new AppsInTossPartnerApiError('Apps in Toss returned an invalid promotion key.', status);
  }
  return requireOpaqueValue(input.key, 'promotion key', status, maximumPromotionKeyLength);
}

/** The documented `4111` business error: HTTP 200 with `resultType: 'FAIL'`. */
function isPromotionExecutionNotFound(response: PartnerApiResponse): boolean {
  if (!response.ok || !isRecord(response.body) || response.body.resultType !== 'FAIL') {
    return false;
  }
  const error = response.body.error;
  return isRecord(error) && error.errorCode === promotionExecutionNotFoundErrorCode;
}

function parsePromotionExecutionStatus(
  input: unknown,
  status: number,
): Exclude<AppsInTossPromotionExecutionStatus, 'NOT_FOUND'> {
  if (input === 'SUCCESS' || input === 'PENDING' || input === 'FAILED') {
    return input;
  }
  throw new AppsInTossPartnerApiError(
    'Apps in Toss returned an unknown promotion execution result.',
    status,
  );
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
    throw new TypeError(
      `${field} must contain 1 to 2048 characters without control or format characters.`,
    );
  }
  return normalized;
}

function normalizeLoginReferrer(value: AppsInTossLoginReferrer): AppsInTossLoginReferrer {
  if (value !== 'DEFAULT' && value !== 'SANDBOX') {
    throw new TypeError('referrer must be DEFAULT or SANDBOX.');
  }
  return value;
}

function normalizeOpaqueValue(value: string, field: string, maximumLength: number): string {
  if (
    value.length === 0
    || value.length > maximumLength
    || value.trim() !== value
    || /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new TypeError(
      `${field} must contain 1 to ${maximumLength} characters without surrounding whitespace, control, or format characters.`,
    );
  }
  return value;
}

function requireOpaqueValue(
  value: unknown,
  field: string,
  status: number,
  maximumLength: number,
): string {
  if (typeof value !== 'string') {
    throw new AppsInTossPartnerApiError(`Apps in Toss returned an invalid ${field}.`, status);
  }
  try {
    return normalizeOpaqueValue(value, field, maximumLength);
  } catch {
    throw new AppsInTossPartnerApiError(`Apps in Toss returned an invalid ${field}.`, status);
  }
}

function requirePositiveInteger(value: unknown, field: string, status: number): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/u.test(value)) {
    parsed = Number(value);
  } else {
    parsed = Number.NaN;
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppsInTossPartnerApiError(`Apps in Toss returned an invalid ${field}.`, status);
  }
  return parsed;
}

function parseTossUserKey(value: unknown): string | undefined {
  let normalized: string | undefined;
  if (typeof value === 'number') {
    normalized = Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  } else if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) {
    normalized = value;
  }
  return normalized;
}

function normalizeTossUserKey(value: unknown, field: string): string {
  const normalized = parseTossUserKey(value);
  if (normalized === undefined) {
    throw new TypeError(`${field} must be a positive Apps in Toss user key.`);
  }
  return normalized;
}

function requireTossUserKey(value: unknown, field: string, status: number): string {
  const normalized = parseTossUserKey(value);
  if (normalized === undefined) {
    throw new AppsInTossPartnerApiError(`Apps in Toss returned an invalid ${field}.`, status);
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
