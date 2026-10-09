/** ONE play / ONE store API V7 transport. Credentials and this client belong on the server. */
export type OnePlayPurchaseEnvironment = 'SANDBOX' | 'COMMERCIAL';
export type OnePlayMarketCode = 'MKT_ONE' | 'MKT_GLB';
export interface OnePlayPurchaseApiInput {
  readonly productId: string;
  readonly purchaseToken: string;
  readonly signal: AbortSignal;
}
export interface OnePlayPurchaseClient {
  readonly clientId: string;
  readonly environment: OnePlayPurchaseEnvironment;
  readonly marketCode: OnePlayMarketCode;
  getPurchaseDetails(input: OnePlayPurchaseApiInput): Promise<unknown>;
  consumePurchase(input: OnePlayPurchaseApiInput & { readonly developerPayload: string }): Promise<void>;
  acknowledgePurchase(input: OnePlayPurchaseApiInput & { readonly developerPayload: string }): Promise<void>;
}
export function createOnePlayPurchaseClient(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: OnePlayPurchaseEnvironment;
  readonly marketCode?: OnePlayMarketCode;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): OnePlayPurchaseClient {
  const clientId = onePlayIdentifier(input.clientId, 128);
  const clientSecret = onePlayIdentifier(input.clientSecret, 4096);
  const environment = input.environment;
  const marketCode = input.marketCode ?? 'MKT_ONE';
  if (!['SANDBOX', 'COMMERCIAL'].includes(environment) || !['MKT_ONE', 'MKT_GLB'].includes(marketCode)) {
    throw new TypeError('ONE play purchase environment is invalid.');
  }
  const origin = environment === 'SANDBOX'
    ? 'https://sbpp.onestore.net'
    : 'https://iap-apis.onestore.net';
  const requestFetch = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;
  async function jsonRequest(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    try {
      const response = await requestFetch(`${origin}${path}`, {
        ...init,
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        if (response.status === 401) {
          cached = undefined;
        }
        await response.body?.cancel().catch(() => undefined);
        throw new Error('HTTP failure');
      }
      const value = await boundedJson(response);
      signal.throwIfAborted();
      return value;
    } catch {
      signal.throwIfAborted();
      // Transport errors and provider responses may contain URL tokens or client secrets.
      throw new Error('ONE play purchase API request failed.');
    }
  }
  async function token(signal: AbortSignal): Promise<string> {
    if (cached !== undefined && cached.expiresAt > now() + 60_000) {
      return cached.token;
    }
    // Each caller owns its abort signal. Never share an abortable OAuth promise between requests.
    const raw = await jsonRequest(
      '/v7/oauth/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-market-code': marketCode,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
      signal,
    );
    if (!onePlayRecord(raw) || raw.client_id !== clientId || typeof raw.token_type !== 'string' || raw.token_type.toLowerCase() !== 'bearer'
      || !onePlayIsIdentifier(raw.access_token, 4096) || /\s/u.test(raw.access_token) || typeof raw.expires_in !== 'number' || !Number.isSafeInteger(raw.expires_in) || raw.expires_in <= 0 || raw.expires_in > 86_400) {
      throw new Error('ONE play OAuth response is invalid.');
    }
    cached = { token: raw.access_token, expiresAt: now() + raw.expires_in * 1000 };
    return cached.token;
  }
  async function request(operation: 'get' | 'consume' | 'acknowledge', request: OnePlayPurchaseApiInput & { readonly developerPayload?: string }): Promise<unknown> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    const type = operation === 'acknowledge' ? 'all' : 'inapp';
    const path = `/v7/apps/${pathPart(clientId)}/purchases/${type}/products/${pathPart(request.productId)}/${pathPart(request.purchaseToken)}${operation === 'get' ? '' : `/${operation}`}`;
    const developerPayload = operation === 'get'
      ? undefined
      : onePlayIdentifier(request.developerPayload, 200);
    if (developerPayload !== undefined && new TextEncoder().encode(developerPayload).length > 200) {
      throw new TypeError('ONE play developer payload is too long.');
    }
    const body = developerPayload === undefined ? undefined : JSON.stringify({ developerPayload });
    const result = await jsonRequest(
      path,
      {
        method: operation === 'get' ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${await token(signal)}`,
          'content-type': 'application/json',
          'x-market-code': marketCode,
        },
        ...(body === undefined ? {} : { body }),
      },
      signal,
    );
    if (operation !== 'get' && (!onePlayRecord(result) || !onePlayRecord(result.result) || result.result.code !== 'Success')) {
      throw new Error('ONE play purchase finalization was not confirmed.');
    }
    return result;
  }
  return {
    clientId,
    environment,
    marketCode,
    getPurchaseDetails: (requestInput) => request('get', requestInput),
    async consumePurchase(requestInput) {
      await request('consume', requestInput);
    },
    async acknowledgePurchase(requestInput) {
      await request('acknowledge', requestInput);
    },
  };
}
export function onePlayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function onePlayIsIdentifier(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function onePlayIdentifier(value: unknown, max = 256): string {
  if (!onePlayIsIdentifier(value, max)) {
    throw new TypeError('ONE play identifier is invalid.');
  }
  return value;
}
function pathPart(value: string): string {
  onePlayIdentifier(value, 4096);
  if (value === '.' || value === '..') {
    throw new TypeError('ONE play path parameter is invalid.');
  }
  return encodeURIComponent(value);
}
async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new Error('Missing ONE play response.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.length;
      if (size > 65_536) {
        throw new Error('ONE play response exceeds its limit.');
      }
      chunks.push(chunk.value);
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
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
