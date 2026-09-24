import { describe, expect, it, vi } from 'vitest';
import type { HttpOptions, HttpResponse } from '@capacitor/core';
import type { GameServicesBackendTransport } from '@mpgd/game-services/client';

import {
  createCapacitorNativeJsonTransport,
  type CreateCapacitorNativeJsonTransportInput,
} from './native-http.js';

const baseUrl = 'https://api.example.com/api';
const allowedOrigin = 'https://api.example.com';

function createFake(input: {
  target?: 'android' | 'ios';
  response?: (options: HttpOptions) => HttpResponse | Promise<HttpResponse>;
  options?: Partial<CreateCapacitorNativeJsonTransportInput>;
}) {
  const calls: HttpOptions[] = [];
  const target = input.target ?? 'android';
  const transport = createCapacitorNativeJsonTransport({
    target,
    baseUrl,
    allowedOrigin,
    getPlatform: () => target,
    http: {
      async request(options) {
        calls.push(options);
        return input.response?.(options) ?? {
          status: 200,
          url: options.url,
          headers: { 'content-type': 'application/json' },
          data: { ok: true },
        };
      },
    },
    ...input.options,
  });
  return { transport, calls };
}

describe('scoped Capacitor native JSON transport', () => {
  it.each(['android', 'ios'] as const)('sends GET and POST JSON through %s native Http', async (target) => {
    const { transport, calls } = createFake({ target });
    const backendTransport: GameServicesBackendTransport = transport;
    await expect(transport.request({ method: 'GET', path: '/health?kind=read' }))
      .resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(backendTransport.send({
      method: 'POST', endpoint: '/game-services/purchases/verify',
      body: { idempotencyKey: 'purchase-1' },
      headers: { authorization: 'Bearer scoped' },
    })).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.com/api/health?kind=read',
      'https://api.example.com/api/game-services/purchases/verify',
    ]);
    expect(calls[0]).toMatchObject({ method: 'GET', disableRedirects: true, responseType: 'json' });
    expect(calls[1]).toMatchObject({
      method: 'POST', disableRedirects: true,
      data: { idempotencyKey: 'purchase-1' },
      headers: { authorization: 'Bearer scoped', 'content-type': 'application/json' },
    });
  });

  it('returns empty JSON as null and parses a JSON string', async () => {
    const empty = createFake({ response: (options) => ({
      status: 204, url: options.url, headers: {}, data: '',
    }) });
    await expect(empty.transport.request({ method: 'GET', path: '/empty' }))
      .resolves.toEqual({ status: 204, body: null });
    const text = createFake({ response: (options) => ({
      status: 200, url: options.url, headers: {}, data: '{"count":2}',
    }) });
    await expect(text.transport.request({ method: 'GET', path: '/json' }))
      .resolves.toEqual({ status: 200, body: { count: 2 } });
  });

  it('rejects malformed JSON, oversized responses, and invalid status values', async () => {
    const malformed = createFake({ response: (options) => ({
      status: 200, url: options.url, headers: {}, data: '<html>bad gateway</html>',
    }) });
    await expect(malformed.transport.request({ method: 'GET', path: '/json' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_JSON' });
    const oversized = createFake({
      response: (options) => ({ status: 200, url: options.url, headers: {}, data: { large: 'abcd' } }),
      options: { maxResponseBytes: 5 },
    });
    await expect(oversized.transport.request({ method: 'GET', path: '/large' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_RESPONSE_TOO_LARGE' });
    const status = createFake({ response: (options) => ({
      status: Number.NaN, url: options.url, headers: {}, data: null,
    }) });
    await expect(status.transport.request({ method: 'GET', path: '/status' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_RESPONSE' });
  });

  it('blocks redirects and any changed response URL before returning data', async () => {
    const redirect = createFake({ response: (options) => ({
      status: 302, url: options.url, headers: { location: 'https://evil.example/' }, data: null,
    }) });
    await expect(redirect.transport.request({ method: 'GET', path: '/moved' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_REDIRECT_BLOCKED' });
    const changed = createFake({ response: () => ({
      status: 200, url: 'https://evil.example/secret', headers: {}, data: { ok: true },
    }) });
    await expect(changed.transport.request({ method: 'GET', path: '/secret' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_CROSS_ORIGIN' });
    const changedRoute = createFake({ response: () => ({
      status: 200, url: 'https://api.example.com/api/other', headers: {}, data: { ok: true },
    }) });
    await expect(changedRoute.transport.request({ method: 'GET', path: '/expected' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_REDIRECT_BLOCKED' });
    expect(redirect.calls[0]?.disableRedirects).toBe(true);
  });

  it('accepts equivalent native URL encoding without allowing a changed route', async () => {
    const nativeNormalized = createFake({ response: (options) => ({
      status: 200,
      url: options.url.replace('%7E', '~').replace('%2C', ','),
      headers: {}, data: { ok: true },
    }) });
    await expect(nativeNormalized.transport.request({
      method: 'GET', path: '/players/%7Eguest?ids=a%2Cb',
    })).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it('fails closed for invalid origins, escaped paths, binary payloads, and wrong platforms', async () => {
    expect(() => createCapacitorNativeJsonTransport({
      target: 'android', baseUrl: 'http://api.example.com', allowedOrigin,
    })).toThrow();
    expect(() => createCapacitorNativeJsonTransport({
      target: 'android', baseUrl, allowedOrigin: 'https://elsewhere.example',
    })).toThrow();
    const { transport, calls } = createFake({ options: { maxRequestBytes: 6 } });
    await expect(transport.request({ method: 'GET', path: '/../outside' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_CROSS_ORIGIN' });
    await expect(transport.request({ method: 'POST', path: '/body', body: { long: 'value' } }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_REQUEST_TOO_LARGE' });
    await expect(transport.request({ method: 'POST', path: '/blob', body: new Blob(['no']) }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_REQUEST' });
    expect(calls).toHaveLength(0);
    const wrong = createFake({ options: { getPlatform: () => 'web' } });
    await expect(wrong.transport.request({ method: 'GET', path: '/health' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_UNSUPPORTED' });
  });

  it('rejects unsafe headers and pre-aborted requests before invoking native Http', async () => {
    const { transport, calls } = createFake({});
    await expect(transport.request({
      method: 'GET', path: '/health', headers: { authorization: 'Bearer valid\r\nX-Injected: yes' },
    })).rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_REQUEST' });
    await expect(transport.request({
      method: 'GET', path: '/health', headers: { host: 'evil.example' },
    })).rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_REQUEST' });
    await expect(transport.request({
      method: 'GET', path: '/health', headers: { Accept: 'application/json;profile=v2' },
    })).rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_REQUEST' });
    await expect(transport.request({
      method: 'POST', path: '/health', body: {}, headers: { 'Content-Type': 'text/plain' },
    })).rejects.toMatchObject({ code: 'NATIVE_HTTP_INVALID_REQUEST' });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.request({ method: 'GET', path: '/health', signal: controller.signal }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_ABORTED' });
    expect(calls).toHaveLength(0);
  });

  it('does not expose native exception details in a failed request', async () => {
    const secret = 'Bearer native-secret';
    const { transport } = createFake({ response: () => { throw new Error(secret); } });
    await expect(transport.request({ method: 'GET', path: '/health' }))
      .rejects.toMatchObject({ code: 'NATIVE_HTTP_FAILED' });
    await expect(transport.request({ method: 'GET', path: '/health' }))
      .rejects.not.toThrow(secret);
  });

  it('times out without claiming to cancel a late native response', async () => {
    vi.useFakeTimers();
    try {
      let finish: ((response: HttpResponse) => void) | undefined;
      const fake = createFake({
        options: { overallTimeoutMs: 10 },
        response: () => new Promise<HttpResponse>((resolve) => { finish = resolve; }),
      });
      const request = fake.transport.request({ method: 'GET', path: '/slow' });
      const timedOut = expect(request).rejects.toMatchObject({ code: 'NATIVE_HTTP_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;
      finish?.({ status: 200, url: fake.calls[0]?.url ?? baseUrl, headers: {}, data: { ok: true } });
      await Promise.resolve();
      expect(fake.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting on AbortSignal but does not claim native cancellation', async () => {
    let finish: ((response: HttpResponse) => void) | undefined;
    const fake = createFake({
      response: () => new Promise<HttpResponse>((resolve) => { finish = resolve; }),
    });
    const abort = new AbortController();
    const request = fake.transport.request({ method: 'POST', path: '/operation', body: { key: '1' },
      signal: abort.signal });
    await Promise.resolve();
    abort.abort();
    await expect(request).rejects.toMatchObject({ code: 'NATIVE_HTTP_ABORTED' });
    finish?.({ status: 200, url: fake.calls[0]?.url ?? baseUrl, headers: {}, data: { ok: true } });
    expect(fake.calls).toHaveLength(1);
  });
});
