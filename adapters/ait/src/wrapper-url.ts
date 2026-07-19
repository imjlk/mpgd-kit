export const aitGameBundleBasePath = '/game/';

export function rewriteAitGameBundleUrl(url: string, origin: string): string {
  const trimmedUrl = url.trim();

  if (trimmedUrl.length === 0) {
    throw new Error('Game bundle asset URL must not be empty.');
  }

  if (trimmedUrl.startsWith('//')) {
    throw new Error('Protocol-relative game bundle asset URLs are not supported.');
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl)) {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error(`Invalid game bundle asset URL: ${trimmedUrl}`);
    }

    if (
      (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
      || parsedUrl.origin !== origin
    ) {
      throw new Error(`External game bundle asset URL is not supported: ${parsedUrl.protocol}`);
    }

    return rewriteAitGameBundleUrl(
      `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
      origin,
    );
  }

  return rewriteAndValidateGamePath(trimmedUrl, trimmedUrl, origin);
}

function rewriteAndValidateGamePath(path: string, originalUrl: string, origin: string): string {
  rejectEncodedTraversal(path, originalUrl);

  const normalizedPath = path.startsWith('/') && !path.startsWith(aitGameBundleBasePath)
    ? path.slice(1)
    : path;
  const resolvedUrl = new URL(normalizedPath, `${origin}${aitGameBundleBasePath}`);

  if (resolvedUrl.origin !== origin || !resolvedUrl.pathname.startsWith(aitGameBundleBasePath)) {
    throw new Error(`Game bundle asset URL escapes the bundle base path: ${originalUrl}`);
  }

  return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
}

function rejectEncodedTraversal(path: string, originalUrl: string): void {
  const rawPath = path.toLowerCase();

  if (
    rawPath.includes('%25')
    || rawPath.includes('%2e')
    || rawPath.includes('%2f')
    || rawPath.includes('%5c')
  ) {
    throw new Error(`Game bundle asset URL contains encoded path traversal: ${originalUrl}`);
  }
}
