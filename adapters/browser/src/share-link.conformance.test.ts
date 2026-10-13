import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LifecycleAdapter, ShareAdapter, ShareIntent, ShareResult } from '@mpgd/platform';
import { runShareLinkConformance } from '@mpgd/platform/share-link-conformance';

import { createBrowserPlatformGateway } from './index';

const documentBase = 'https://game.example/play/index.html';
const lifecycle: LifecycleAdapter = {
  onPause: () => () => {},
  onResume: () => () => {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function shareOf(sharing: ShareAdapter | undefined): (intent: ShareIntent) => Promise<ShareResult> {
  const share = sharing?.share?.bind(sharing);

  if (share === undefined) {
    throw new Error('The gateway offers no share.');
  }

  return share;
}

describe('browser share links', () => {
  it('hands Web Share only links the ShareIntent contract accepts, normalized and still relative', async () => {
    const urls: (string | null)[] = [];
    const gateway = createBrowserPlatformGateway({
      lifecycle,
      async share(data) {
        urls.push(data.url ?? null);
      },
    });

    await expect(runShareLinkConformance({
      name: 'browser:web-share',
      share: shareOf(gateway.sharing),
      sharedResult: { status: 'shared' },
      host: {
        handedLinks: () => urls,
        expectedLink: (link) => link,
      },
    })).resolves.toMatchObject({ name: 'browser:web-share' });
  });

  it('copies the same links to the clipboard, resolved against the document base', async () => {
    vi.stubGlobal('document', { baseURI: documentBase });
    const copied: (string | null)[] = [];
    const gateway = createBrowserPlatformGateway({
      lifecycle,
      async writeClipboardText(text) {
        copied.push(text.split('\n')[1] ?? null);
      },
    });

    await expect(runShareLinkConformance({
      name: 'browser:clipboard',
      share: shareOf(gateway.sharing),
      sharedResult: { status: 'shared' },
      host: {
        handedLinks: () => copied,
        expectedLink: (link) => new URL(link, documentBase).href,
      },
    })).resolves.toMatchObject({ name: 'browser:clipboard' });
  });
});
