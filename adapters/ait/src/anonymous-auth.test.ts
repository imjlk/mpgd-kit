import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAitAnonymousAuthCode } from './anonymous-auth';

const platform = vi.hoisted(() => ({ supported: true, next: 0 }));
vi.mock('@ait-kit/sdk/webview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ait-kit/sdk/webview')>();
  return {
    ...actual,
    createWebViewIdentity: () =>
      actual.createWebViewIdentity({
        framework: {
          User: {
            getAnonymousKey: undefined,
            createAnonymousKeyAuthCode: Object.assign(
              async function () {
                return { code: `fresh-${++platform.next}`, expiresIn: 300 };
              },
              { isSupported: () => platform.supported },
            ),
          },
        },
      }),
  };
});

describe('AIT anonymous authentication via ait-kit', () => {
  beforeEach(() => {
    platform.supported = true;
    platform.next = 0;
  });
  it('requests fresh SDK codes rather than caching a reusable identity', async () => {
    expect(await createAitAnonymousAuthCode()).toEqual({ code: 'fresh-1', expiresIn: 300 });
    expect(await createAitAnonymousAuthCode()).toEqual({ code: 'fresh-2', expiresIn: 300 });
  });
  it('preserves unsupported-runtime rejection without issuing a code', async () => {
    platform.supported = false;
    await expect(createAitAnonymousAuthCode()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(platform.next).toBe(0);
  });
});
