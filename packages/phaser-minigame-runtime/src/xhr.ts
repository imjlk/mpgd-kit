import { MiniGameEvent, MiniGameEventTarget } from './events.js';
import {
  MiniGameRuntimeError,
  type MiniGameHost,
  type MiniGameRequestResponseType,
  type MiniGameResponse,
  type MiniGameTransportOptions,
} from './host.js';
import { normalizeMiniGameHttpsOrigin, parseMiniGameHttpsUrl } from './url.js';

export type MiniGameXMLHttpRequestResponseType = '' | MiniGameRequestResponseType;

const forbiddenResponseHeaders = new Set(['set-cookie', 'set-cookie2']);
const forbiddenRequestHeaders = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
]);

export class MiniGameProgressEvent extends MiniGameEvent {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;

  constructor(
    type: string,
    init: Readonly<{
      readonly lengthComputable?: boolean;
      readonly loaded?: number;
      readonly total?: number;
    }> = {},
  ) {
    super(type);
    this.lengthComputable = init.lengthComputable === true;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
}

export interface MiniGameXMLHttpRequestConstructor {
  new(): MiniGameXMLHttpRequest;
  readonly UNSENT: 0;
  readonly OPENED: 1;
  readonly HEADERS_RECEIVED: 2;
  readonly LOADING: 3;
  readonly DONE: 4;
}

export class MiniGameXMLHttpRequest extends MiniGameEventTarget {
  static readonly UNSENT = 0 as const;
  static readonly OPENED = 1 as const;
  static readonly HEADERS_RECEIVED = 2 as const;
  static readonly LOADING = 3 as const;
  static readonly DONE = 4 as const;

  readonly UNSENT = MiniGameXMLHttpRequest.UNSENT;
  readonly OPENED = MiniGameXMLHttpRequest.OPENED;
  readonly HEADERS_RECEIVED = MiniGameXMLHttpRequest.HEADERS_RECEIVED;
  readonly LOADING = MiniGameXMLHttpRequest.LOADING;
  readonly DONE = MiniGameXMLHttpRequest.DONE;

  readyState: 0 | 1 | 2 | 3 | 4 = MiniGameXMLHttpRequest.UNSENT;
  response: unknown = null;
  responseText = '';
  responseURL = '';
  status = 0;
  statusText = '';
  timeout = 0;
  withCredentials = false;
  onabort: ((event: MiniGameProgressEvent) => void) | null = null;
  onerror: ((event: MiniGameProgressEvent) => void) | null = null;
  onload: ((event: MiniGameProgressEvent) => void) | null = null;
  onloadend: ((event: MiniGameProgressEvent) => void) | null = null;
  onloadstart: ((event: MiniGameProgressEvent) => void) | null = null;
  onprogress: ((event: MiniGameProgressEvent) => void) | null = null;
  onreadystatechange: ((event: MiniGameEvent) => void) | null = null;
  ontimeout: ((event: MiniGameProgressEvent) => void) | null = null;
  readonly #host: MiniGameHost;
  readonly #options: MiniGameTransportOptions;
  readonly #requestHeaders = new Map<string, string>();
  readonly #responseHeaders = new Map<string, string>();
  #method: 'GET' | undefined;
  #responseType: MiniGameXMLHttpRequestResponseType = '';
  #url = '';
  #generation = 0;
  #mimeType: string | undefined;
  #sendStarted = false;

  constructor(host: MiniGameHost, options: MiniGameTransportOptions = {}) {
    super();
    this.#host = host;
    this.#options = options;
  }

  get responseType(): MiniGameXMLHttpRequestResponseType {
    return this.#responseType;
  }

  set responseType(value: MiniGameXMLHttpRequestResponseType) {
    if (this.#sendStarted) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_INVALID_STATE',
        'Mini-game XMLHttpRequest responseType cannot change after send() starts.',
      );
    }

    this.#responseType = value;
  }

  open(
    method: string,
    url: string,
    async = true,
    user?: string | null,
    password?: string | null,
  ): void {
    if (method.toUpperCase() !== 'GET') {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_METHOD_UNSUPPORTED',
        `Mini-game XMLHttpRequest only supports GET; received ${method}.`,
      );
    }

    if (!async) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_SYNC_UNSUPPORTED',
        'Synchronous mini-game XMLHttpRequest is not supported.',
      );
    }

    if (hasNonEmptyCredential(user) || hasNonEmptyCredential(password)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_CREDENTIALS_UNSUPPORTED',
        'Mini-game XMLHttpRequest does not support URL credentials.',
      );
    }

    this.#generation += 1;
    this.#method = 'GET';
    this.#url = String(url);
    this.#requestHeaders.clear();
    this.#mimeType = undefined;
    this.#responseType = '';
    this.#resetResponseState();
    this.#sendStarted = false;
    this.#setReadyState(MiniGameXMLHttpRequest.OPENED);
  }

  setRequestHeader(name: string, value: string): void {
    this.#assertOpened();

    if (this.#sendStarted) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_INVALID_STATE',
        'Mini-game XMLHttpRequest headers cannot change after send() starts.',
      );
    }

    const normalizedName = name.trim().toLowerCase();

    if (!/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/u.test(normalizedName)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_INVALID_HEADER',
        `Mini-game XMLHttpRequest header name is invalid: ${name}`,
      );
    }

    if (/[\r\n]/u.test(value)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_INVALID_HEADER',
        `Mini-game XMLHttpRequest header value contains a line break: ${name}`,
      );
    }

    if (isForbiddenRequestHeader(normalizedName)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_FORBIDDEN_HEADER',
        `Mini-game XMLHttpRequest cannot set forbidden request header ${name}.`,
      );
    }

    const existing = this.#requestHeaders.get(normalizedName);
    this.#requestHeaders.set(
      normalizedName,
      existing === undefined ? value : `${existing}, ${value}`,
    );
  }

  overrideMimeType(mimeType: string): void {
    this.#mimeType = mimeType;
  }

  getAllResponseHeaders(): string {
    if (this.readyState < MiniGameXMLHttpRequest.HEADERS_RECEIVED) {
      return '';
    }

    return [...this.#responseHeaders]
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
  }

  getResponseHeader(name: string): string | null {
    if (this.readyState < MiniGameXMLHttpRequest.HEADERS_RECEIVED) {
      return null;
    }

    return this.#responseHeaders.get(name.toLowerCase()) ?? null;
  }

  send(body?: unknown): void {
    this.#assertOpened();

    if (this.#sendStarted) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_SEND_ALREADY_STARTED',
        'Mini-game XMLHttpRequest send() may only be called once per open().',
      );
    }

    if (body !== undefined && body !== null) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_BODY_UNSUPPORTED',
        'GET mini-game XMLHttpRequest cannot send a request body.',
      );
    }

    if (!isSupportedResponseType(this.responseType)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_RESPONSE_TYPE_UNSUPPORTED',
        `Mini-game XMLHttpRequest does not support responseType ${String(this.responseType)}.`,
      );
    }

    if (this.withCredentials) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_CREDENTIALS_UNSUPPORTED',
        'Mini-game XMLHttpRequest does not support withCredentials.',
      );
    }

    const timeoutMs = resolveRequestTimeout(this.timeout, this.#options.requestTimeoutMs);
    this.#sendStarted = true;
    const generation = ++this.#generation;
    this.#emitProgress('loadstart');

    if (generation !== this.#generation) {
      return;
    }

    void this.#send(generation, timeoutMs);
  }

  abort(): void {
    if (this.readyState === MiniGameXMLHttpRequest.UNSENT) {
      return;
    }

    if (this.readyState === MiniGameXMLHttpRequest.DONE) {
      this.#generation += 1;
      this.#resetResponseState();
      this.#resetRequestToUnsent();
      return;
    }

    if (!this.#sendStarted) {
      return;
    }

    const generation = ++this.#generation;
    this.#resetResponseState();
    this.#setReadyState(MiniGameXMLHttpRequest.DONE);

    if (generation !== this.#generation) {
      return;
    }

    this.#emitProgress('abort');

    if (generation !== this.#generation) {
      return;
    }

    this.#emitProgress('loadend');

    if (generation !== this.#generation) {
      return;
    }

    this.#resetRequestToUnsent();
  }

  async #send(generation: number, timeoutMs: number | undefined): Promise<void> {
    try {
      const response = await withTimeout(this.#load(timeoutMs), timeoutMs);

      if (generation !== this.#generation) {
        return;
      }

      assertMiniGameResponse(response);
      this.status = response.status;
      this.statusText = statusTextFor(response.status);
      this.responseURL = this.#url;
      this.#responseHeaders.clear();

      for (const [name, value] of Object.entries(response.headers ?? {})) {
        const normalizedName = name.toLowerCase();

        if (!forbiddenResponseHeaders.has(normalizedName)) {
          this.#responseHeaders.set(normalizedName, value);
        }
      }

      if (this.#mimeType !== undefined && !this.#responseHeaders.has('content-type')) {
        this.#responseHeaders.set('content-type', this.#mimeType);
      }

      this.#setReadyState(MiniGameXMLHttpRequest.HEADERS_RECEIVED);

      if (generation !== this.#generation) {
        return;
      }

      this.#setReadyState(MiniGameXMLHttpRequest.LOADING);

      if (generation !== this.#generation) {
        return;
      }

      const byteLength = response.data instanceof ArrayBuffer
        ? response.data.byteLength
        : utf8ByteLength(response.data);
      this.#emitProgress('progress', byteLength);

      if (generation !== this.#generation) {
        return;
      }

      this.#assignResponse(response.data);
      this.#setReadyState(MiniGameXMLHttpRequest.DONE);

      if (generation !== this.#generation) {
        return;
      }

      this.#emitProgress('load', byteLength);

      if (generation !== this.#generation) {
        return;
      }

      this.#emitProgress('loadend', byteLength);
    } catch (error) {
      if (generation !== this.#generation) {
        return;
      }

      this.#resetResponseState();
      this.#setReadyState(MiniGameXMLHttpRequest.DONE);

      if (generation !== this.#generation) {
        return;
      }

      if (error instanceof MiniGameRequestTimeoutError) {
        this.#emitProgress('timeout', 0, error);
      } else {
        this.#emitProgress('error', 0, error);
      }

      if (generation !== this.#generation) {
        return;
      }

      this.#emitProgress('loadend');
    }
  }

  async #load(timeoutMs: number | undefined): Promise<MiniGameResponse> {
    const classified = classifyMiniGameRequestUrl(this.#url, this.#options.allowedRemoteOrigins);

    if (classified.kind === 'local') {
      if (this.#host.readLocalFile === undefined) {
        throw new MiniGameRuntimeError(
          'MINIGAME_LOCAL_FILE_UNAVAILABLE',
          `The mini-game host does not provide local file transport for ${classified.path}.`,
        );
      }

      return {
        status: 200,
        data: await this.#host.readLocalFile(classified.path),
      };
    }

    if (this.#host.request === undefined) {
      throw new MiniGameRuntimeError(
        'MINIGAME_REMOTE_REQUEST_UNAVAILABLE',
        `The mini-game host does not provide remote request transport for ${classified.url}.`,
      );
    }

    return this.#host.request({
      url: classified.url,
      method: this.#method ?? 'GET',
      headers: Object.fromEntries(this.#requestHeaders),
      responseType: this.responseType === '' ? 'text' : this.responseType,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  #assignResponse(data: string | ArrayBuffer): void {
    const text = typeof data === 'string' ? data : decodeUtf8(data);

    switch (this.responseType) {
      case '':
      case 'text':
        this.responseText = text;
        this.response = text;
        break;
      case 'arraybuffer':
        this.responseText = '';
        this.response = typeof data === 'string' ? encodeUtf8(data).buffer : data;
        break;
      case 'json':
        this.responseText = text;
        try {
          this.response = text.length === 0 ? null : JSON.parse(text) as unknown;
        } catch {
          this.response = null;
        }
        break;
    }
  }

  #resetResponseState(): void {
    this.#responseHeaders.clear();
    this.response = null;
    this.responseText = '';
    this.responseURL = '';
    this.status = 0;
    this.statusText = '';
  }

  #resetRequestToUnsent(): void {
    this.readyState = MiniGameXMLHttpRequest.UNSENT;
    this.#method = undefined;
    this.#url = '';
    this.#sendStarted = false;
  }

  #assertOpened(): void {
    if (this.readyState !== MiniGameXMLHttpRequest.OPENED || this.#method === undefined) {
      throw new MiniGameRuntimeError(
        'MINIGAME_XHR_INVALID_STATE',
        'Mini-game XMLHttpRequest must be opened before this operation.',
      );
    }
  }

  #setReadyState(state: 0 | 1 | 2 | 3 | 4): void {
    this.readyState = state;
    const event = new MiniGameEvent('readystatechange');
    event.target = this;
    event.currentTarget = this;
    this.invokeEventCallback(this.onreadystatechange, event);
    this.dispatchEvent(event);
  }

  #emitProgress(type: string, total = 0, error?: unknown): void {
    const event = new MiniGameProgressEvent(type, {
      lengthComputable: total > 0,
      loaded: total,
      total,
    });
    event.target = this;
    event.currentTarget = this;

    if (error !== undefined) {
      Object.assign(event, { error });
    }

    switch (type) {
      case 'abort':
        this.invokeEventCallback(this.onabort, event);
        break;
      case 'error':
        this.invokeEventCallback(this.onerror, event);
        break;
      case 'load':
        this.invokeEventCallback(this.onload, event);
        break;
      case 'loadend':
        this.invokeEventCallback(this.onloadend, event);
        break;
      case 'loadstart':
        this.invokeEventCallback(this.onloadstart, event);
        break;
      case 'progress':
        this.invokeEventCallback(this.onprogress, event);
        break;
      case 'timeout':
        this.invokeEventCallback(this.ontimeout, event);
        break;
    }

    this.dispatchEvent(event);
  }
}

export function createMiniGameXMLHttpRequestConstructor(
  host: MiniGameHost,
  options: MiniGameTransportOptions = {},
): MiniGameXMLHttpRequestConstructor {
  return class HostMiniGameXMLHttpRequest extends MiniGameXMLHttpRequest {
    static override readonly UNSENT = 0 as const;
    static override readonly OPENED = 1 as const;
    static override readonly HEADERS_RECEIVED = 2 as const;
    static override readonly LOADING = 3 as const;
    static override readonly DONE = 4 as const;

    constructor() {
      super(host, options);
    }
  };
}

export type ClassifiedMiniGameRequestUrl =
  | Readonly<{ readonly kind: 'local'; readonly path: string }>
  | Readonly<{ readonly kind: 'remote'; readonly url: string }>;

export function classifyMiniGameRequestUrl(
  input: string,
  allowedRemoteOrigins: readonly string[] = [],
): ClassifiedMiniGameRequestUrl {
  if (/^https:\/\//iu.test(input)) {
    const parsed = parseMiniGameHttpsUrl(
      input,
      'MINIGAME_REMOTE_URL_INVALID',
      'Invalid remote mini-game URL',
      'MINIGAME_REMOTE_CREDENTIALS_BLOCKED',
    );
    const allowed = new Set(allowedRemoteOrigins.map(normalizeMiniGameHttpsOrigin));

    if (!allowed.has(parsed.origin)) {
      throw new MiniGameRuntimeError(
        'MINIGAME_REMOTE_ORIGIN_BLOCKED',
        `Remote mini-game request origin is not allowed: ${parsed.origin}`,
      );
    }

    return { kind: 'remote', url: parsed.href };
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(input)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_REQUEST_PROTOCOL_BLOCKED',
      `Mini-game requests only support package paths and allowed HTTPS URLs: ${input}`,
    );
  }

  if (input.startsWith('//') || input.startsWith('\\\\')) {
    throw new MiniGameRuntimeError(
      'MINIGAME_REQUEST_PROTOCOL_BLOCKED',
      `Protocol-relative mini-game request URLs are not supported: ${input}`,
    );
  }

  const withoutQuery = input.split(/[?#]/u, 1)[0] ?? '';
  let decoded: string;

  try {
    decoded = decodeURIComponent(withoutQuery).replace(/^\/+|^(?:\.\/)+/u, '');
  } catch {
    throw new MiniGameRuntimeError(
      'MINIGAME_LOCAL_PATH_INVALID',
      `Mini-game local file path contains invalid encoding: ${input}`,
    );
  }

  const segments = decoded.split('/');

  if (
    decoded.length === 0
    || decoded.includes('\\')
    || decoded.includes('\0')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new MiniGameRuntimeError(
      'MINIGAME_LOCAL_PATH_INVALID',
      `Mini-game local file path must remain inside the package: ${input}`,
    );
  }

  return { kind: 'local', path: decoded };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MiniGameRequestTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class MiniGameRequestTimeoutError extends Error {}

function resolveRequestTimeout(
  requestTimeout: number,
  configuredTimeout: number | undefined,
): number | undefined {
  const timeout = requestTimeout === 0 ? configuredTimeout : requestTimeout;

  if (timeout === undefined) {
    return undefined;
  }

  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new MiniGameRuntimeError(
      'MINIGAME_XHR_TIMEOUT_INVALID',
      'Mini-game XMLHttpRequest timeout must be a non-negative finite number.',
    );
  }

  return timeout === 0 ? undefined : timeout;
}

function isSupportedResponseType(value: unknown): value is MiniGameXMLHttpRequestResponseType {
  return value === '' || value === 'text' || value === 'arraybuffer' || value === 'json';
}

function isForbiddenRequestHeader(name: string): boolean {
  return forbiddenRequestHeaders.has(name)
    || name.startsWith('proxy-')
    || name.startsWith('sec-');
}

function assertMiniGameResponse(response: MiniGameResponse): void {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new MiniGameRuntimeError(
      'MINIGAME_RESPONSE_STATUS_INVALID',
      `Mini-game host returned an invalid HTTP status: ${String(response.status)}.`,
    );
  }

  if (typeof response.data !== 'string' && !(response.data instanceof ArrayBuffer)) {
    throw new MiniGameRuntimeError(
      'MINIGAME_RESPONSE_DATA_INVALID',
      'Mini-game host response data must be a string or ArrayBuffer.',
    );
  }
}

function utf8ByteLength(value: string): number {
  let byteLength = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0xfffd;

    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      byteLength += 3;
    } else if (codePoint <= 0x7f) {
      byteLength += 1;
    } else if (codePoint <= 0x7ff) {
      byteLength += 2;
    } else if (codePoint <= 0xffff) {
      byteLength += 3;
    } else {
      byteLength += 4;
    }
  }

  return byteLength;
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];

  for (const character of value) {
    let codePoint = character.codePointAt(0) ?? 0xfffd;

    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18));
      bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }

  return Uint8Array.from(bytes);
}

function decodeUtf8(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let output = '';
  let index = 0;

  while (index < bytes.length) {
    const first = bytes[index];

    if (first === undefined) {
      break;
    }

    if (first <= 0x7f) {
      output += String.fromCodePoint(first);
      index += 1;
      continue;
    }

    let continuationCount = 0;
    let codePoint = 0;
    let minimum = 0;

    if (first >= 0xc2 && first <= 0xdf) {
      continuationCount = 1;
      codePoint = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuationCount = 2;
      codePoint = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuationCount = 3;
      codePoint = first & 0x07;
      minimum = 0x10000;
    } else {
      output += '\ufffd';
      index += 1;
      continue;
    }

    let valid = index + continuationCount < bytes.length;

    for (let offset = 1; valid && offset <= continuationCount; offset += 1) {
      const continuation = bytes[index + offset];

      if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
        valid = false;
      } else {
        codePoint = (codePoint << 6) | (continuation & 0x3f);
      }
    }

    if (
      !valid
      || codePoint < minimum
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      output += '\ufffd';
      index += 1;
      continue;
    }

    output += String.fromCodePoint(codePoint);
    index += continuationCount + 1;
  }

  return output;
}

function statusTextFor(status: number): string {
  if (status >= 200 && status < 300) {
    return 'OK';
  }

  return status === 404 ? 'Not Found' : '';
}

function hasNonEmptyCredential(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}
