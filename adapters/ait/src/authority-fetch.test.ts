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
