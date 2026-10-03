import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAitAuthority } from './authority-fetch';

describe('AIT authority fetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not bind an injected WebView fetch to its dependency object', async () => {
    const resource = new URL('https://example.test/api/iap/verify');
    const init = { method: 'POST', body: '{}', headers: { 'Idempotency-Key': 'purchase-1' } };
    const dependencies = {
      fetch: vi.fn(function (this: unknown, actualResource: RequestInfo | URL, actualInit?: RequestInit) {
        expect(this).toBeUndefined();
        expect(actualResource).toBe(resource);
        expect(actualInit).toBe(init);
        return Promise.resolve(Response.json({ verified: true }));
      }),
    };

    const response = await fetchAitAuthority({
      resource,
      init,
      fetch: dependencies.fetch,
    });

    expect(await response.json()).toEqual({ verified: true });
    expect(dependencies.fetch).toHaveBeenCalledOnce();
  });

  it('propagates native transport failures for the caller to keep a grant pending', async () => {
    const failure = new TypeError('Failed to fetch');
    await expect(fetchAitAuthority({
      resource: 'https://example.test/api/iap/verify',
      fetch: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it('reports a missing WebView transport clearly', async () => {
    vi.stubGlobal('fetch', undefined);
    await expect(fetchAitAuthority({
      resource: 'https://example.test/api/iap/verify',
    })).rejects.toThrow('AIT authority fetch is unavailable.');
  });
});

describe('AIT authority fetch resource policy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects non-https authority resources before invoking the transport', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));

    for (const resource of [
      'http://authority.example/api/iap/verify',
      new URL('http://10.0.0.5/api/iap/verify'),
      new Request('http://authority.example/api/iap/verify'),
      'ftp://authority.example/api/iap/verify',
      'javascript:alert(1)',
      'data:text/plain,verified',
      'http://localhost.attacker.example/api/iap/verify',
    ]) {
      await expect(fetchAitAuthority({ resource, fetch: fetchImplementation }))
        .rejects.toThrow(/AIT authority resource must use https:/);
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects resources that cannot be resolved to an absolute URL', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));
    vi.stubGlobal('location', undefined);

    await expect(fetchAitAuthority({ resource: '/api/iap/verify', fetch: fetchImplementation }))
      .rejects.toThrow('AIT authority resource must be an absolute https: URL.');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('allows https resources and loopback http development authorities', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));

    for (const resource of [
      'https://authority.example/api/iap/verify',
      new URL('https://authority.example:8443/api/iap/verify'),
      new Request('https://authority.example/api/iap/verify'),
      'http://localhost:8787/api/iap/verify',
      'http://127.0.0.1:8787/api/iap/verify',
    ]) {
      await expect(fetchAitAuthority({ resource, fetch: fetchImplementation }))
        .resolves.toBeInstanceOf(Response);
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
  });

  it('resolves relative resources against the https page origin', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));
    vi.stubGlobal('location', { href: 'https://game.web.tossmini.com/index.html' });

    await expect(fetchAitAuthority({ resource: '/api/iap/verify', fetch: fetchImplementation }))
      .resolves.toBeInstanceOf(Response);
    expect(fetchImplementation).toHaveBeenCalledWith('/api/iap/verify', undefined);
  });
});
