import type { GooglePlayProductPurchaseClient } from './google-play-purchase.js';
import type {
  GooglePlayVoidedPurchase,
  GooglePlayVoidedPurchasesClient,
  GooglePlayVoidedPurchasesPage,
} from './google-play-store-server.js';

const publisherOrigin = 'https://androidpublisher.googleapis.com';

export interface GooglePlayPublisherClientOptions {
  /** Supplies an androidpublisher-scoped OAuth access token for each request. */
  readonly getAccessToken: (signal: AbortSignal) => Promise<string> | string;
  readonly fetch?: typeof fetch;
}

/**
 * Google Play purchase verification and post-ledger finalization transport.
 * The caller owns OAuth credential rotation and must never expose this client to the game.
 */
export function createGooglePlayPublisherClient(
  options: GooglePlayPublisherClientOptions,
): GooglePlayProductPurchaseClient & GooglePlayVoidedPurchasesClient {
  const requestFetch = options.fetch ?? fetch;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const accessToken = await options.getAccessToken(signal);
    if (accessToken.length === 0 || /[\s\x00-\x1f\x7f]/u.test(accessToken)) {
      throw new TypeError('Google Play Publisher access token is invalid.');
    }
    let response: Response;
    try {
      response = await requestFetch(`${publisherOrigin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${accessToken}` },
        // Workers reject redirect: 'error'; a manual 3xx/opaque redirect is never ok and fails below.
        redirect: 'manual',
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw new DOMException('Google Play Publisher request was cancelled.', 'AbortError');
      }
      // Fetch errors can contain the request URL (including the purchase token).
      throw new Error('Google Play Publisher request failed.');
    }
    // Also reject a redirect followed by an injected fetch that ignores redirect: 'manual'.
    if (!response.ok || response.redirected) {
      await discardBody(response);
      // Do not forward an error body or URL: both can contain purchase credentials.
      throw new Error(`Google Play Publisher request failed (HTTP ${response.status}).`);
    }
    return response;
  }

  return {
    async getProductPurchaseV2({ packageName, purchaseToken, signal }) {
      const path = `${purchasePath(packageName)}/productsv2/tokens/${pathPart(purchaseToken)}`;
      const response = await request('GET', path, signal);
      try {
        return await readBoundedJson(response);
      } catch {
        if (signal.aborted) {
          throw new DOMException('Google Play Publisher request was cancelled.', 'AbortError');
        }
        throw new Error('Google Play Publisher returned invalid purchase JSON.');
      }
    },
    async acknowledgeProductPurchase({ packageName, productId, purchaseToken, signal }) {
      const path = `${purchasePath(packageName)}/products/${pathPart(productId)}`
        + `/tokens/${pathPart(purchaseToken)}:acknowledge`;
      await discardBody(await request('POST', path, signal));
    },
    async consumeProductPurchase({ packageName, productId, purchaseToken, signal }) {
      const path = `${purchasePath(packageName)}/products/${pathPart(productId)}`
        + `/tokens/${pathPart(purchaseToken)}:consume`;
      await discardBody(await request('POST', path, signal));
    },
    async listVoidedPurchases({
      packageName,
      startTimeMillis,
      endTimeMillis,
      pageToken,
      maxResults,
      signal,
    }) {
      // purchases.voidedpurchases.list, in-app products only (type 0, the
      // default): https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list
      const query = new URLSearchParams();
      if (pageToken === undefined) {
        query.set('startTime', String(readMillis(startTimeMillis, 'startTimeMillis')));
        query.set('endTime', String(readMillis(endTimeMillis, 'endTimeMillis')));
      } else {
        query.set('token', pageToken);
      }
      if (maxResults !== undefined) {
        if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 1000) {
          throw new RangeError('maxResults must be an integer from 1 to 1000.');
        }
        query.set('maxResults', String(maxResults));
      }
      const response = await request(
        'GET',
        `${purchasePath(packageName)}/voidedpurchases?${query.toString()}`,
        signal,
      );
      let body: unknown;
      try {
        body = await readBoundedJson(response);
      } catch {
        if (signal.aborted) {
          throw new DOMException('Google Play Publisher request was cancelled.', 'AbortError');
        }
        throw new Error('Google Play Publisher returned invalid voided purchases JSON.');
      }
      return readVoidedPurchasesPage(body);
    },
  };
}

function readMillis(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer of milliseconds.`);
  }
  return value;
}

function readVoidedPurchasesPage(body: unknown): GooglePlayVoidedPurchasesPage {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Google Play Publisher returned an invalid voided purchases page.');
  }
  const record = body as Readonly<Record<string, unknown>>;
  const entries = record.voidedPurchases ?? [];
  if (!Array.isArray(entries)) {
    throw new Error('Google Play Publisher returned an invalid voided purchases page.');
  }
  const voidedPurchases: GooglePlayVoidedPurchase[] = [];
  let droppedEntries = 0;
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      droppedEntries += 1;
      continue;
    }
    const item = entry as Readonly<Record<string, unknown>>;
    if (typeof item.purchaseToken !== 'string' || item.purchaseToken.length === 0) {
      droppedEntries += 1;
      continue;
    }
    voidedPurchases.push({
      purchaseToken: item.purchaseToken,
      ...(typeof item.orderId === 'string' ? { orderId: item.orderId } : {}),
      ...pickMillisOrCode(item, 'voidedTimeMillis'),
      ...pickMillisOrCode(item, 'purchaseTimeMillis'),
      ...pickMillisOrCode(item, 'voidedSource'),
      ...pickMillisOrCode(item, 'voidedReason'),
    });
  }
  const pagination = record.tokenPagination;
  const nextPageToken = typeof pagination === 'object' && pagination !== null
    ? (pagination as Readonly<Record<string, unknown>>).nextPageToken
    : undefined;
  return {
    voidedPurchases,
    ...(typeof nextPageToken === 'string' && nextPageToken.length > 0 ? { nextPageToken } : {}),
    ...(droppedEntries === 0 ? {} : { droppedEntries }),
  };
}

function pickMillisOrCode(
  item: Readonly<Record<string, unknown>>,
  key: 'voidedTimeMillis' | 'purchaseTimeMillis' | 'voidedSource' | 'voidedReason',
): Partial<Record<typeof key, string | number>> {
  const value = item[key];
  return typeof value === 'string' || typeof value === 'number' ? { [key]: value } : {};
}

function purchasePath(packageName: string): string {
  return `/androidpublisher/v3/applications/${pathPart(packageName)}/purchases`;
}

function pathPart(value: string): string {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || value.trim() !== value
    || /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new TypeError('Google Play Publisher path parameter is invalid.');
  }
  return encodeURIComponent(value);
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = response.body;
  if (body === null) {
    throw new Error('Missing Google Play Publisher response body.');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > 1024 * 1024) {
        throw new Error('Google Play Publisher response exceeds maximum size.');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
