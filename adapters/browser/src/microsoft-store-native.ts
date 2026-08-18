import {
  microsoftStoreBillingMethod,
  type MicrosoftStoreDigitalGoodsItem,
  type MicrosoftStoreDigitalGoodsPurchase,
  type MicrosoftStoreDigitalGoodsService,
  type MicrosoftStorePaymentRequest,
  type MicrosoftStorePaymentResponse,
} from './microsoft-store.js';

export const microsoftStoreNativeBridgeProtocol = 'mpgd.microsoft-store.native.v1' as const;

export type MicrosoftStoreNativeBridgeMethod =
  | 'catalog.getDetails'
  | 'identity.getCustomerCollectionsId'
  | 'identity.signIn'
  | 'purchase.list'
  | 'purchase.request';

export type MicrosoftStoreNativePurchaseStatus =
  | 'already-purchased'
  | 'network-error'
  | 'not-purchased'
  | 'server-error'
  | 'succeeded';

export interface MicrosoftStoreNativeProductDetail {
  readonly itemId: string;
  readonly title: string;
  readonly description?: string;
  readonly price: {
    readonly currencyCode: string;
    readonly formatted: string;
  };
}

export interface MicrosoftStoreNativeBridgeClient {
  /** Runs platform sign-in and Store account linking entirely in the trusted native host. */
  signIn(): Promise<MicrosoftStoreNativePlayerSession>;
  getDetails(itemIds: readonly string[]): Promise<readonly MicrosoftStoreNativeProductDetail[]>;
  getCustomerCollectionsId(input: {
    /** Short-lived Entra token for the Store collections-key creation audience. */
    readonly serviceTicket: string;
    /** Stable authenticated game-player ID embedded into the resulting Store key. */
    readonly publisherUserId: string;
  }): Promise<string>;
  listPurchases(): Promise<readonly MicrosoftStoreDigitalGoodsPurchase[]>;
  requestPurchase(itemId: string): Promise<Readonly<{
    /** Microsoft Digital Goods product ID; when present, this must equal the requested itemId. */
    purchaseToken?: string;
    status: MicrosoftStoreNativePurchaseStatus;
  }>>;
  dispose(): void;
}

export interface MicrosoftStoreNativePlayerSession {
  /** Unix epoch milliseconds when this game-scoped session expires. */
  readonly expiresAt: number;
  readonly playerId: string;
  /** Game-scoped bearer. The native host must never return Microsoft or Store credentials. */
  readonly sessionToken: string;
}

export interface MicrosoftStoreNativeWebViewMessageEvent {
  readonly data: unknown;
}

export interface MicrosoftStoreNativeWebViewTransport {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: MicrosoftStoreNativeWebViewMessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MicrosoftStoreNativeWebViewMessageEvent) => void,
  ): void;
}

export interface CreateMicrosoftStoreNativeBridgeClientInput {
  readonly webView: MicrosoftStoreNativeWebViewTransport;
  readonly createRequestId?: () => string;
  readonly timeoutMs?: number;
  readonly purchaseTimeoutMs?: number;
  readonly signInTimeoutMs?: number;
  readonly now?: () => number;
}

export interface MicrosoftStoreNativeCommerceRuntime {
  readonly getDigitalGoodsService: () => Promise<MicrosoftStoreDigitalGoodsService>;
  readonly createPaymentRequest: (
    methodData: readonly {
      readonly supportedMethods: typeof microsoftStoreBillingMethod;
      readonly data: { readonly sku: string };
    }[],
  ) => MicrosoftStorePaymentRequest;
}

export class MicrosoftStoreNativeBridgeError extends Error {
  override readonly name = 'MicrosoftStoreNativeBridgeError';

  constructor(
    readonly code:
      | 'BRIDGE_DISPOSED'
      | 'BRIDGE_PROTOCOL_ERROR'
      | 'BRIDGE_TIMEOUT'
      | 'NATIVE_OPERATION_FAILED'
      | 'NATIVE_PURCHASE_NETWORK_ERROR'
      | 'NATIVE_PURCHASE_SERVER_ERROR',
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface PendingBridgeRequest {
  readonly method: MicrosoftStoreNativeBridgeMethod;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const defaultTimeoutMs = 30_000;
const defaultPurchaseTimeoutMs = 10 * 60_000;
const defaultSignInTimeoutMs = 10 * 60_000;
const maximumBridgeStringLength = 16_384;
const maximumItemCount = 64;
const maximumPendingRequests = 64;
const maximumRetainedRequestIds = 4_096;
const minimumPlayerSessionLifetimeMs = 60_000;
const maximumPlayerSessionLifetimeMs = 24 * 60 * 60_000;
// Session tokens are ASCII JWTs or opaque bearers; these are UTF-16 code-unit limits.
const minimumPlayerSessionTokenLength = 32;
const maximumPlayerSessionTokenLength = 4_096;
const maximumPlayerIdLength = 256;

export function createMicrosoftStoreNativeBridgeClient(
  input: CreateMicrosoftStoreNativeBridgeClientInput,
): MicrosoftStoreNativeBridgeClient {
  const timeoutMs = requireTimeout(input.timeoutMs ?? defaultTimeoutMs, 'timeoutMs');
  const purchaseTimeoutMs = requireTimeout(
    input.purchaseTimeoutMs ?? defaultPurchaseTimeoutMs,
    'purchaseTimeoutMs',
  );
  const signInTimeoutMs = requireTimeout(
    input.signInTimeoutMs ?? defaultSignInTimeoutMs,
    'signInTimeoutMs',
  );
  const now = input.now ?? Date.now;
  const createRequestId = input.createRequestId ?? defaultRequestId;
  const pending = new Map<string, PendingBridgeRequest>();
  const issuedRequestIds = new Set<string>();
  let disposed = false;

  const onMessage = (event: MicrosoftStoreNativeWebViewMessageEvent): void => {
    const envelope = readResponseEnvelope(event.data);
    if (envelope === undefined) {
      return;
    }
    const request = pending.get(envelope.requestId);
    if (request === undefined || request.method !== envelope.method) {
      return;
    }
    pending.delete(envelope.requestId);
    clearTimeout(request.timeout);
    if (envelope.ok) {
      request.resolve(envelope.result);
      return;
    }
    request.reject(
      new MicrosoftStoreNativeBridgeError('NATIVE_OPERATION_FAILED', envelope.errorCode),
    );
  };

  input.webView.addEventListener('message', onMessage);

  const request = (
    method: MicrosoftStoreNativeBridgeMethod,
    payload: Readonly<Record<string, unknown>>,
    operationTimeoutMs = timeoutMs,
  ): Promise<unknown> => {
    if (disposed) {
      return Promise.reject(new MicrosoftStoreNativeBridgeError('BRIDGE_DISPOSED'));
    }
    if (pending.size >= maximumPendingRequests) {
      return Promise.reject(
        new MicrosoftStoreNativeBridgeError(
          'BRIDGE_PROTOCOL_ERROR',
          'Native bridge has too many pending requests.',
        ),
      );
    }
    let requestId: string;
    try {
      requestId = requireIdentifier(createRequestId(), 'native bridge request ID', 128);
    } catch (cause) {
      return Promise.reject(
        new MicrosoftStoreNativeBridgeError(
          'BRIDGE_PROTOCOL_ERROR',
          'Native bridge request ID is invalid.',
          { cause },
        ),
      );
    }
    if (issuedRequestIds.has(requestId)) {
      return Promise.reject(
        new MicrosoftStoreNativeBridgeError(
          'BRIDGE_PROTOCOL_ERROR',
          'Native bridge request ID was reused.',
        ),
      );
    }
    issuedRequestIds.add(requestId);
    if (issuedRequestIds.size > maximumRetainedRequestIds) {
      for (const retainedRequestId of issuedRequestIds) {
        if (!pending.has(retainedRequestId)) {
          issuedRequestIds.delete(retainedRequestId);
          break;
        }
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new MicrosoftStoreNativeBridgeError('BRIDGE_TIMEOUT'));
      }, operationTimeoutMs);
      pending.set(requestId, { method, reject, resolve, timeout });
      try {
        input.webView.postMessage({
          protocol: microsoftStoreNativeBridgeProtocol,
          requestId,
          method,
          payload,
        });
      } catch (cause) {
        pending.delete(requestId);
        clearTimeout(timeout);
        reject(new MicrosoftStoreNativeBridgeError(
          'NATIVE_OPERATION_FAILED',
          'Native bridge transport rejected the request.',
          { cause },
        ));
      }
    });
  };

  const client: MicrosoftStoreNativeBridgeClient = {
    async signIn() {
      return readPlayerSession(
        await request('identity.signIn', {}, signInTimeoutMs),
        now(),
      );
    },
    async getDetails(itemIds: readonly string[]) {
      const normalized = normalizeItemIds(itemIds);
      const result = await request('catalog.getDetails', { itemIds: normalized });
      return readProductDetails(result, normalized);
    },
    async getCustomerCollectionsId(identityInput: {
      readonly serviceTicket: string;
      readonly publisherUserId: string;
    }) {
      const serviceTicket = requireIdentifier(
        identityInput.serviceTicket,
        'Microsoft Store collections service ticket',
        maximumBridgeStringLength,
      );
      const publisherUserId = requireIdentifier(
        identityInput.publisherUserId,
        'Microsoft Store publisher user ID',
        512,
      );
      const result = await request('identity.getCustomerCollectionsId', {
        serviceTicket,
        publisherUserId,
      });
      const record = requireRecord(result, 'native identity result');
      return requireNativeIdentifier(
        record.userStoreId,
        'Microsoft Store User Collections ID',
        maximumBridgeStringLength,
      );
    },
    async listPurchases() {
      return readPurchases(await request('purchase.list', {}));
    },
    async requestPurchase(itemId: string) {
      const normalizedItemId = requireIdentifier(itemId, 'Microsoft Store item ID', 256);
      const result = requireRecord(
        await request('purchase.request', { itemId: normalizedItemId }, purchaseTimeoutMs),
        'native purchase result',
      );
      const status = readPurchaseStatus(result.status);
      const purchaseToken = result.purchaseToken === undefined
        ? undefined
        : requireNativeIdentifier(result.purchaseToken, 'Microsoft Store purchase token', 1_024);
      if (purchaseToken !== undefined && purchaseToken !== normalizedItemId) {
        throw protocolError('Native purchase token must equal its Microsoft Store item ID.');
      }
      return Object.freeze({
        status,
        ...(purchaseToken === undefined ? {} : { purchaseToken }),
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      input.webView.removeEventListener('message', onMessage);
      for (const pendingRequest of pending.values()) {
        clearTimeout(pendingRequest.timeout);
        pendingRequest.reject(new MicrosoftStoreNativeBridgeError('BRIDGE_DISPOSED'));
      }
      pending.clear();
      issuedRequestIds.clear();
    },
  };
  return Object.freeze(client);
}

export function createMicrosoftStoreNativeCommerceRuntime(
  bridge: Omit<MicrosoftStoreNativeBridgeClient, 'signIn'>,
): MicrosoftStoreNativeCommerceRuntime {
  const service: MicrosoftStoreDigitalGoodsService = Object.freeze({
    async getDetails(
      itemIds: readonly string[],
    ): Promise<readonly MicrosoftStoreDigitalGoodsItem[]> {
      return (await bridge.getDetails(itemIds)).map((detail) => Object.freeze({
        itemId: detail.itemId,
        title: detail.title,
        ...(detail.description === undefined ? {} : { description: detail.description }),
        price: Object.freeze({
          currency: detail.price.currencyCode,
          formatted: detail.price.formatted,
        }),
      }));
    },
    listPurchases: () => bridge.listPurchases(),
  });

  const runtime: MicrosoftStoreNativeCommerceRuntime = {
    getDigitalGoodsService: () => Promise.resolve(service),
    createPaymentRequest(methodData: readonly {
      readonly supportedMethods: typeof microsoftStoreBillingMethod;
      readonly data: { readonly sku: string };
    }[]) {
      const sku = readPaymentSku(methodData);
      return Object.freeze({
        async show(): Promise<MicrosoftStorePaymentResponse> {
          const purchase = await bridge.requestPurchase(sku);
          switch (purchase.status) {
            case 'succeeded':
            case 'already-purchased':
              return Object.freeze({
                details: Object.freeze({ purchaseToken: purchase.purchaseToken ?? sku }),
              });
            case 'not-purchased':
              throw abortError('The Microsoft Store purchase was cancelled.');
            case 'network-error':
              throw new MicrosoftStoreNativeBridgeError('NATIVE_PURCHASE_NETWORK_ERROR');
            case 'server-error':
              throw new MicrosoftStoreNativeBridgeError('NATIVE_PURCHASE_SERVER_ERROR');
          }
        },
      });
    },
  };
  return Object.freeze(runtime);
}

export function getGlobalMicrosoftStoreNativeWebView():
MicrosoftStoreNativeWebViewTransport | undefined {
  const chrome = Reflect.get(globalThis, 'chrome');
  if (!isRecord(chrome)) {
    return undefined;
  }
  const webView = Reflect.get(chrome, 'webview');
  return isWebViewTransport(webView) ? webView : undefined;
}

function readPaymentSku(
  methodData: readonly {
    readonly supportedMethods: typeof microsoftStoreBillingMethod;
    readonly data: { readonly sku: string };
  }[],
): string {
  const method = methodData[0];
  if (methodData.length !== 1 || method?.supportedMethods !== microsoftStoreBillingMethod) {
    throw new TypeError('Native Microsoft Store payment request must contain one Store method.');
  }
  const data: unknown = method.data;
  return requireIdentifier(isRecord(data) ? data.sku : undefined, 'Microsoft Store item ID', 256);
}

function readResponseEnvelope(input: unknown):
  | Readonly<{
      errorCode: string;
      method: MicrosoftStoreNativeBridgeMethod;
      ok: false;
      requestId: string;
    }>
  | Readonly<{
      method: MicrosoftStoreNativeBridgeMethod;
      ok: true;
      requestId: string;
      result: unknown;
    }>
  | undefined {
  if (!isRecord(input) || input.protocol !== microsoftStoreNativeBridgeProtocol) {
    return undefined;
  }
  const requestId = readIdentifier(input.requestId, 128);
  const method = readMethod(input.method);
  if (requestId === undefined || method === undefined || typeof input.ok !== 'boolean') {
    return undefined;
  }
  if (input.ok) {
    return { method, ok: true, requestId, result: input.result };
  }
  const errorCode = readIdentifier(input.errorCode, 256);
  return errorCode === undefined ? undefined : { errorCode, method, ok: false, requestId };
}

function readProductDetails(
  input: unknown,
  requestedItemIds: readonly string[],
): readonly MicrosoftStoreNativeProductDetail[] {
  const record = requireRecord(input, 'native product details result');
  if (!Array.isArray(record.items) || record.items.length > requestedItemIds.length) {
    throw protocolError('Native product details are invalid.');
  }
  const requested = new Set(requestedItemIds);
  const seen = new Set<string>();
  return Object.freeze(record.items.map((candidate) => {
    const item = requireRecord(candidate, 'native product detail');
    const itemId = requireNativeIdentifier(item.itemId, 'Microsoft Store item ID', 256);
    if (!requested.has(itemId) || seen.has(itemId)) {
      throw protocolError('Native product detail identity is invalid.');
    }
    seen.add(itemId);
    const price = requireRecord(item.price, 'native product price');
    const currencyCode = requireNativeIdentifier(
      price.currencyCode,
      'currency code',
      3,
    ).toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currencyCode)) {
      throw protocolError('Native product currency is invalid.');
    }
    return Object.freeze({
      itemId,
      title: requireText(item.title, 'Microsoft Store item title', 512),
      ...(item.description === undefined
        ? {}
        : {
            description: requireText(
              item.description,
              'Microsoft Store item description',
              4_096,
              true,
            ),
          }),
      price: Object.freeze({
        currencyCode,
        formatted: requireText(price.formatted, 'Microsoft Store formatted price', 128),
      }),
    });
  }));
}

function readPurchases(input: unknown): readonly MicrosoftStoreDigitalGoodsPurchase[] {
  const record = requireRecord(input, 'native purchases result');
  if (!Array.isArray(record.items) || record.items.length > maximumItemCount) {
    throw protocolError('Native purchases are invalid.');
  }
  const seen = new Set<string>();
  return Object.freeze(record.items.map((candidate) => {
    const purchase = requireRecord(candidate, 'native purchase');
    const itemId = requireNativeIdentifier(purchase.itemId, 'Microsoft Store item ID', 256);
    if (seen.has(itemId)) {
      throw protocolError('Native purchase identity is duplicated.');
    }
    seen.add(itemId);
    const purchaseToken = requireNativeIdentifier(
      purchase.purchaseToken,
      'Microsoft Store purchase token',
      1_024,
    );
    if (purchaseToken !== itemId) {
      throw protocolError('Native purchase token must equal its Microsoft Store item ID.');
    }
    return Object.freeze({ itemId, purchaseToken });
  }));
}

function readPlayerSession(
  input: unknown,
  nowMs: number,
): MicrosoftStoreNativePlayerSession {
  const session = requireExactRecord(
    input,
    ['expiresAt', 'playerId', 'sessionToken'],
    'native player session',
  );
  const expiresAt = session.expiresAt;
  if (
    typeof expiresAt !== 'number'
    || !Number.isSafeInteger(expiresAt)
    || expiresAt < nowMs + minimumPlayerSessionLifetimeMs
    || expiresAt > nowMs + maximumPlayerSessionLifetimeMs
  ) {
    throw protocolError('Native player session expiration is invalid.');
  }
  const sessionToken = requireNativeIdentifier(
    session.sessionToken,
    'native player session token',
    maximumPlayerSessionTokenLength,
  );
  if (sessionToken.length < minimumPlayerSessionTokenLength || /\s/u.test(sessionToken)) {
    throw protocolError('Native player session token is invalid.');
  }
  return Object.freeze({
    expiresAt,
    playerId: requireNativeIdentifier(
      session.playerId,
      'native player ID',
      maximumPlayerIdLength,
    ),
    sessionToken,
  });
}

function normalizeItemIds(input: readonly string[]): readonly string[] {
  if (input.length === 0 || input.length > maximumItemCount) {
    throw new TypeError(`Microsoft Store item IDs must contain 1-${maximumItemCount} values.`);
  }
  const normalized = input.map(
    (itemId) => requireIdentifier(itemId, 'Microsoft Store item ID', 256),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('Microsoft Store item IDs must be unique.');
  }
  return Object.freeze(normalized);
}

function readPurchaseStatus(input: unknown): MicrosoftStoreNativePurchaseStatus {
  switch (input) {
    case 'already-purchased':
    case 'network-error':
    case 'not-purchased':
    case 'server-error':
    case 'succeeded':
      return input;
    default:
      throw protocolError('Native purchase status is invalid.');
  }
}

function readMethod(input: unknown): MicrosoftStoreNativeBridgeMethod | undefined {
  switch (input) {
    case 'catalog.getDetails':
    case 'identity.getCustomerCollectionsId':
    case 'identity.signIn':
    case 'purchase.list':
    case 'purchase.request':
      return input;
    default:
      return undefined;
  }
}

function isWebViewTransport(input: unknown): input is MicrosoftStoreNativeWebViewTransport {
  return isRecord(input)
    && typeof input.postMessage === 'function'
    && typeof input.addEventListener === 'function'
    && typeof input.removeEventListener === 'function';
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw protocolError(`${label} is invalid.`);
  }
  return input;
}

function requireExactRecord(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(input, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw protocolError(`${label} is invalid.`);
  }
  return record;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function requireIdentifier(input: unknown, label: string, maximumLength: number): string {
  const value = readIdentifier(input, maximumLength);
  if (value === undefined) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireNativeIdentifier(input: unknown, label: string, maximumLength: number): string {
  const value = readIdentifier(input, maximumLength);
  if (value === undefined) {
    throw protocolError(`${label} is invalid.`);
  }
  return value;
}

function readIdentifier(input: unknown, maximumLength: number): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const value = input.trim();
  return value.length > 0
    && value.length <= maximumLength
    && !/[\p{Cc}\p{Cf}]/u.test(value)
      ? value
      : undefined;
}

function requireText(
  input: unknown,
  label: string,
  maximumLength: number,
  allowDescriptionWhitespace = false,
): string {
  if (
    typeof input !== 'string'
    || input.length > maximumLength
    || input.trim().length === 0
  ) {
    throw protocolError(`${label} is invalid.`);
  }
  const inspected = allowDescriptionWhitespace ? input.replace(/[\t\n\r]/gu, '') : input;
  if (/[\p{Cc}\p{Cf}]/u.test(inspected)) {
    throw protocolError(`${label} is invalid.`);
  }
  return input;
}

function requireTimeout(input: number, label: string): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 30 * 60_000) {
    throw new TypeError(`${label} must be a positive timeout no greater than 30 minutes.`);
  }
  return input;
}

function defaultRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required for Microsoft Store native bridge requests.');
  }
  return globalThis.crypto.randomUUID();
}

function protocolError(message: string): MicrosoftStoreNativeBridgeError {
  return new MicrosoftStoreNativeBridgeError('BRIDGE_PROTOCOL_ERROR', message);
}

function abortError(message: string): Error {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
