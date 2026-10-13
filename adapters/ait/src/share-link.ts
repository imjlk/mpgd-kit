import {
  hasRouteControlCharacter,
  normalizeRootRelativeRoute,
  normalizeShareLink,
} from '@mpgd/platform/routes';

/**
 * Converts a game share link to the app-owned `intoss://<app>` deep link, or
 * answers `undefined` when the link could name another host or app. An
 * `intoss://<app>` link is reduced to the path it carries and checked with
 * `normalizeRootRelativeRoute` from `@mpgd/platform/routes`. Any other link
 * must pass `normalizeShareLink`, the rule every target's share links follow,
 * and an absolute link is then reduced to its path the same way.
 */
export function toAitShareLink(input: string, appName: string): string | undefined {
  // No share link needs a control character, and URL parsing drops tabs and
  // newlines, which can turn `/<tab>/host` into an authority.
  if (hasRouteControlCharacter(input)) {
    return undefined;
  }

  // An app link is read as the path it carries. Matching the prefix as text
  // avoids a parser differential: `intoss:` is not a special scheme, so
  // `intoss://other\@app/x` has the host `app` for WHATWG URL parsing but
  // `other` for Android's `Uri`.
  const appPrefix = `intoss://${appName}`;

  if (input.startsWith(appPrefix)) {
    const rest = input.slice(appPrefix.length);

    if (rest !== '' && !/^[/?#]/u.test(rest)) {
      return undefined;
    }

    return toAppLink(rest.startsWith('/') ? rest : `/${rest}`, appName);
  }

  const link = normalizeShareLink(input);

  if (link === undefined) {
    return undefined;
  }

  if (link.startsWith('/')) {
    return toAppLink(link, appName);
  }

  const { pathname, search, hash } = new URL(link);

  return toAppLink(`${pathname}${search}${hash}`, appName);
}

/** Trims an Apps in Toss app name and requires letters, numbers, and hyphens only. */
export function normalizeAitAppName(value: string): string {
  const normalized = value.trim();

  if (!/^[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error('AIT appName must contain only letters, numbers, and hyphens.');
  }

  return normalized;
}

export interface AitShareRequest {
  readonly text: string;
  /** The app-owned `intoss://<app>` link to share. */
  readonly link: string;
  readonly previewImageUrl?: string;
}

/**
 * Reads a `share.share` payload the way the Apps in Toss host does, or answers
 * `undefined` when it has no `text` or no link the host would share. The host
 * and the sandbox bridge both use it, so they accept the same requests.
 */
export function readAitShareRequest(payload: unknown, appName: string): AitShareRequest | undefined {
  const intent = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : {};
  const { text, deepLink, previewImageUrl } = intent;

  if (typeof text !== 'string' || typeof deepLink !== 'string') {
    return undefined;
  }

  const link = toAitShareLink(deepLink, appName);

  if (link === undefined) {
    return undefined;
  }

  return typeof previewImageUrl === 'string' && previewImageUrl.startsWith('https://')
    ? { text, link, previewImageUrl }
    : { text, link };
}

function toAppLink(path: string, appName: string): string | undefined {
  const route = normalizeRootRelativeRoute(path);

  return route === undefined ? undefined : `intoss://${appName}${route}`;
}
