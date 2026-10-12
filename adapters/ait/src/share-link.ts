import { hasRouteControlCharacter, normalizeRootRelativeRoute } from '@mpgd/platform/routes';

/**
 * Converts a game share link to the app-owned `intoss://<app>` deep link, or
 * answers `undefined` when the link could name another host or app. A
 * root-relative, `http(s)://`, or `intoss://<app>` link is reduced to the
 * path it carries and checked with `normalizeRootRelativeRoute` from
 * `@mpgd/platform/routes`, the same rule notification deep links follow.
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

  if (input.startsWith('/')) {
    return toAppLink(input, appName);
  }

  let parsed: URL;

  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }

  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? toAppLink(`${parsed.pathname}${parsed.search}${parsed.hash}`, appName)
    : undefined;
}

/** Trims an Apps in Toss app name and requires letters, numbers, and hyphens only. */
export function normalizeAitAppName(value: string): string {
  const normalized = value.trim();

  if (!/^[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error('AIT appName must contain only letters, numbers, and hyphens.');
  }

  return normalized;
}

/** The app name an `intoss://` link names, when it is a plain name. */
export function readAitShareLinkAppName(input: string): string | undefined {
  return /^intoss:\/\/([A-Za-z0-9-]+)(?:[/?#]|$)/u.exec(input)?.[1];
}

function toAppLink(path: string, appName: string): string | undefined {
  const route = normalizeRootRelativeRoute(path);

  return route === undefined ? undefined : `intoss://${appName}${route}`;
}
