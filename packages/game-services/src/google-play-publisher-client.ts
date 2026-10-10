import type { GooglePlayProductPurchaseClient } from './google-play-purchase.js';

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
): GooglePlayProductPurchaseClient {
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
  };
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
