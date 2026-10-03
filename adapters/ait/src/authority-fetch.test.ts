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
        expect(actualResource).toBe(resource.href);
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
    expect(fetchImplementation).toHaveBeenCalledWith('https://game.web.tossmini.com/api/iap/verify', undefined);
  });

  it('forwards the validated representation to the transport', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));
    const request = new Request('https://authority.example/api/iap/verify', { method: 'POST', body: '{}' });

    await fetchAitAuthority({ resource: 'https://authority.example:443/api/iap/verify', fetch: fetchImplementation });
    await fetchAitAuthority({ resource: new URL('https://authority.example/api/iap/verify'), fetch: fetchImplementation });
    await fetchAitAuthority({ resource: request, fetch: fetchImplementation });

    expect(fetchImplementation).toHaveBeenNthCalledWith(1, 'https://authority.example/api/iap/verify', undefined);
    expect(fetchImplementation).toHaveBeenNthCalledWith(2, 'https://authority.example/api/iap/verify', undefined);
    expect(fetchImplementation).toHaveBeenNthCalledWith(3, request, undefined);
  });

  it("validates URL-like objects by shape so another realm's URL cannot bypass the scheme policy", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));
    vi.stubGlobal('location', { href: 'https://game.web.tossmini.com/index.html' });

    // Mirrors a URL constructed in an iframe: `instanceof URL` is false, but
    // `href` still names the cleartext resource that would actually be fetched.
    const crossRealmUrl = { href: 'http://authority.example/api/iap/verify' } as unknown as URL;
    expect(crossRealmUrl instanceof URL).toBe(false);

    await expect(fetchAitAuthority({ resource: crossRealmUrl, fetch: fetchImplementation }))
      .rejects.toThrow(/AIT authority resource must use https:/);
    expect(fetchImplementation).not.toHaveBeenCalled();

    const crossRealmHttpsUrl = { href: 'https://authority.example/api/iap/verify' } as unknown as URL;
    await expect(fetchAitAuthority({ resource: crossRealmHttpsUrl, fetch: fetchImplementation }))
      .resolves.toBeInstanceOf(Response);
    expect(fetchImplementation).toHaveBeenCalledWith('https://authority.example/api/iap/verify', undefined);
  });

  it('forwards only a same-realm Request unchanged and rejects Request-like objects', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));
    vi.stubGlobal('location', { href: 'https://game.web.tossmini.com/index.html' });

    // Native fetch stringifies a non-Request input through `toString`, so a
    // duck-typed `url` is not what would be fetched.
    const toStringSpoof = {
      url: 'https://authority.example/api/iap/verify',
      toString: () => 'http://attacker.example/api/iap/verify',
    };
    for (const resource of [
      toStringSpoof,
      { url: 'https://authority.example/api/iap/verify' },
      { url: 'http://authority.example/api/iap/verify' },
      { href: 'https://authority.example/api/iap/verify', url: 'https://authority.example/api/iap/verify' },
      { href: 'http://authority.example/api/iap/verify', url: 'https://authority.example/api/iap/verify' },
      Object.assign(Object.create(null), { url: 'https://authority.example/api/iap/verify' }),
    ]) {
      await expect(fetchAitAuthority({ resource: resource as unknown as Request, fetch: fetchImplementation }))
        .rejects.toThrow('AIT authority resource must be a string, URL, or same-realm Request.');
    }
    expect(fetchImplementation).not.toHaveBeenCalled();

    const request = new Request('https://authority.example/api/iap/verify', { method: 'POST', body: '{}' });
    await expect(fetchAitAuthority({ resource: request, fetch: fetchImplementation }))
      .resolves.toBeInstanceOf(Response);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(request, undefined);
  });

  it('rejects resources that are neither a string, URL-like, nor a same-realm Request', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ verified: true }));
    vi.stubGlobal('location', { href: 'https://game.web.tossmini.com/index.html' });

    for (const resource of [
      {},
      { toString: () => 'https://authority.example/api/iap/verify' },
      { href: new URL('https://authority.example/api/iap/verify') },
      { url: 42 },
      null,
      undefined,
      42,
    ]) {
      await expect(fetchAitAuthority({ resource: resource as unknown as RequestInfo, fetch: fetchImplementation }))
        .rejects.toThrow('AIT authority resource must be a string, URL, or same-realm Request.');
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
