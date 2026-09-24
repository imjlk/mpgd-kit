import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from '@capacitor/core';

export type CapacitorNativeHttpErrorCode =
  | 'NATIVE_HTTP_CONFIGURATION'
  | 'NATIVE_HTTP_UNSUPPORTED'
  | 'NATIVE_HTTP_INVALID_REQUEST'
  | 'NATIVE_HTTP_REQUEST_TOO_LARGE'
  | 'NATIVE_HTTP_RESPONSE_TOO_LARGE'
  | 'NATIVE_HTTP_INVALID_RESPONSE'
  | 'NATIVE_HTTP_INVALID_JSON'
  | 'NATIVE_HTTP_REDIRECT_BLOCKED'
  | 'NATIVE_HTTP_CROSS_ORIGIN'
  | 'NATIVE_HTTP_TIMEOUT'
  | 'NATIVE_HTTP_ABORTED'
  | 'NATIVE_HTTP_FAILED';

/** Deliberately omits URLs, headers, and native SDK exception details. */
export class CapacitorNativeHttpError extends Error {
  readonly code: CapacitorNativeHttpErrorCode;

  constructor(code: CapacitorNativeHttpErrorCode) {
    super(`Capacitor native JSON request failed: ${code}.`);
    this.name = 'CapacitorNativeHttpError';
    this.code = code;
  }
}

export interface CapacitorJsonRequest {
  readonly method: 'GET' | 'POST';
  /** Relative API path beginning with one slash; a query string is allowed. */
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Stops waiting in JS; it does not cancel an in-flight native request. */
  readonly signal?: AbortSignal;
}

export interface CapacitorJsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A narrow JSON API that structurally satisfies GameServicesBackendTransport
 * without importing game-services or pretending to implement Fetch.
 */
export interface CapacitorNativeJsonTransport {
  request(input: CapacitorJsonRequest): Promise<CapacitorJsonResponse>;
  send(input: {
    readonly method: 'POST';
    readonly endpoint: string;
    readonly body: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<CapacitorJsonResponse>;
}

export interface CreateCapacitorNativeJsonTransportInput {
  readonly target: 'android' | 'ios';
  readonly baseUrl: string;
  /** Exact HTTPS origin of the API; initial requests never use another origin. */
  readonly allowedOrigin: string;
  readonly connectTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  /** Checked after the native bridge has already returned data to JS. */
  readonly maxResponseBytes?: number;
  /** Inject only for tests or a host-owned native Http implementation. */
  readonly http?: Pick<typeof CapacitorHttp, 'request'>;
  /** Inject only for deterministic tests. */
  readonly getPlatform?: () => string;
}

const defaultMaxRequestBytes = 256 * 1024;
const defaultMaxResponseBytes = 1024 * 1024;
const defaultConnectTimeoutMs = 10_000;
const defaultReadTimeoutMs = 15_000;
const defaultOverallTimeoutMs = 25_000;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9a-z-]+$/u;

export function createCapacitorNativeJsonTransport(
  input: CreateCapacitorNativeJsonTransportInput,
): CapacitorNativeJsonTransport {
  const base = parseHttpsUrl(input.baseUrl);
  const allowedOrigin = parseHttpsUrl(input.allowedOrigin);
  if (allowedOrigin.href !== `${allowedOrigin.origin}/` || allowedOrigin.origin !== base.origin
    || base.username !== '' || base.password !== ''
    || base.search !== '' || base.hash !== '') {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_CONFIGURATION');
  }
  const basePath = base.pathname.replace(/\/+$/u, '');
  const maxRequestBytes = positiveInteger(input.maxRequestBytes, defaultMaxRequestBytes);
  const maxResponseBytes = positiveInteger(input.maxResponseBytes, defaultMaxResponseBytes);
  const connectTimeoutMs = positiveInteger(input.connectTimeoutMs, defaultConnectTimeoutMs);
  const readTimeoutMs = positiveInteger(input.readTimeoutMs, defaultReadTimeoutMs);
  const overallTimeoutMs = positiveInteger(input.overallTimeoutMs, defaultOverallTimeoutMs);
  const http = input.http ?? CapacitorHttp;
  const getPlatform = input.getPlatform ?? (() => Capacitor.getPlatform());
  const encoder = new TextEncoder();

  async function request(inputRequest: CapacitorJsonRequest): Promise<CapacitorJsonResponse> {
    if (getPlatform() !== input.target) {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_UNSUPPORTED');
    }
    if (inputRequest.signal?.aborted === true) {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_ABORTED');
    }
    const url = resolvePath(inputRequest.path, base, basePath);
    const headers = normalizeHeaders(inputRequest.headers);
    let data: unknown;
    let serializedData: string | undefined;
    if (inputRequest.method === 'GET') {
      if (inputRequest.body !== undefined) {
        throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
      }
    } else if (inputRequest.method === 'POST') {
      try {
        assertJsonValue(inputRequest.body, new WeakSet<object>(), 0);
        serializedData = JSON.stringify(inputRequest.body);
      } catch {
        throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
      }
      if (serializedData === undefined) {
        throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
      }
      if (encoder.encode(serializedData).byteLength > maxRequestBytes) {
        throw new CapacitorNativeHttpError('NATIVE_HTTP_REQUEST_TOO_LARGE');
      }
      // Native serializers must receive a JSON value, never its serialized
      // string. Parse the size-checked snapshot so caller mutation cannot
      // change the native request after validation.
      data = JSON.parse(serializedData) as unknown;
      headers['content-type'] = 'application/json';
    } else {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
    }
    headers.accept = 'application/json';
    const options: HttpOptions = {
      url: url.href,
      method: inputRequest.method,
      headers,
      responseType: 'json',
      disableRedirects: true,
      connectTimeout: connectTimeoutMs,
      readTimeout: readTimeoutMs,
      ...(inputRequest.method === 'POST' ? { data } : {}),
    };
    const response = await waitForNativeResponse(
      http,
      options,
      inputRequest.signal,
      overallTimeoutMs,
    );
    if (!isRecord(response) || !Number.isInteger(response.status)
      || response.status < 100 || response.status > 599
      || typeof response.url !== 'string') {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_RESPONSE');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_REDIRECT_BLOCKED');
    }
    let responseUrl: URL;
    try {
      responseUrl = new URL(response.url);
    } catch {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_RESPONSE');
    }
    if (responseUrl.origin !== url.origin) {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_CROSS_ORIGIN');
    }
    if (responseUrl.username !== '' || responseUrl.password !== '' || responseUrl.hash !== ''
      || normalizeNativePath(responseUrl.pathname) !== normalizeNativePath(url.pathname)
      || new URLSearchParams(responseUrl.search).toString()
        !== new URLSearchParams(url.search).toString()) {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_REDIRECT_BLOCKED');
    }
    const raw = response.data as unknown;
    let serialized: string;
    try {
      serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_JSON');
    }
    if (encoder.encode(serialized ?? '').byteLength > maxResponseBytes) {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_RESPONSE_TOO_LARGE');
    }
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return { status: response.status, body: null };
    }
    let body: unknown;
    try {
      body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      assertJsonValue(body, new WeakSet<object>(), 0);
    } catch {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_JSON');
    }
    return { status: response.status, body };
  }

  return {
    request,
    send(inputRequest) {
      return request({
        method: 'POST',
        path: inputRequest.endpoint,
        body: inputRequest.body,
        ...(inputRequest.headers === undefined ? {} : { headers: inputRequest.headers }),
      });
    },
  };
}

function parseHttpsUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '') {
      return parsed;
    }
  } catch {
    // Normalized to a stable, non-sensitive code below.
  }
  throw new CapacitorNativeHttpError('NATIVE_HTTP_CONFIGURATION');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_CONFIGURATION');
  }
  return selected;
}

function resolvePath(path: string, base: URL, basePath: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
  }
  let resolved: URL;
  try {
    resolved = new URL(`${base.origin}${basePath}${path}`);
  } catch {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
  }
  if (resolved.origin !== base.origin
    || (basePath !== '' && !resolved.pathname.startsWith(`${basePath}/`))) {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_CROSS_ORIGIN');
  }
  return resolved;
}

/** Native URL stacks may decode harmless path escapes while preserving the route. */
function normalizeNativePath(path: string): string {
  return path.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9._~,*-]$/u.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

function normalizeHeaders(input: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.toLowerCase();
    if (!headerNamePattern.test(name) || typeof value !== 'string'
      || /[\r\n]/u.test(value) || name === 'host' || name === 'content-length'
      || name === 'accept' || name === 'content-type') {
      throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
    }
    headers[name] = value;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, seen: WeakSet<object>, depth: number): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) {
    return;
  }
  if (typeof value !== 'object' || depth >= 32 || seen.has(value)) {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
    throw new CapacitorNativeHttpError('NATIVE_HTTP_INVALID_REQUEST');
  }
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonValue(entry, seen, depth + 1);
  }
  seen.delete(value);
}

async function waitForNativeResponse(
  http: Pick<typeof CapacitorHttp, 'request'>,
  options: HttpOptions,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HttpResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const pending = Promise.resolve().then(() => http.request(options));
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CapacitorNativeHttpError('NATIVE_HTTP_TIMEOUT')), timeoutMs);
  });
  const abort = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) {
      return;
    }
    onAbort = () => reject(new CapacitorNativeHttpError('NATIVE_HTTP_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([pending, timeout, abort]);
  } catch (error) {
    if (error instanceof CapacitorNativeHttpError) {
      throw error;
    }
    throw new CapacitorNativeHttpError('NATIVE_HTTP_FAILED');
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
