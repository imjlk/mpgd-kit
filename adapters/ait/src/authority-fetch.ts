/**
 * Invokes the AIT WebView's fetch as a standalone function. Calling an injected
 * native fetch through a dependency object's `.fetch()` method gives it that
 * object as `this`, which can reject otherwise valid purchase-grant requests on
 * iOS before they reach the game authority.
 *
 * Keep the game's authentication, idempotency headers, timeout policy, and
 * response validation in its authority client. This helper only owns the
 * WebView transport invocation, so all game-owned authority endpoints can use
 * the same safe call shape.
 *
 * Authority calls carry grant evidence and idempotency headers, so the
 * resource must resolve to an `https:` origin. Plain `http:` is accepted only
 * for a loopback development authority (`localhost` or `127.0.0.1`).
 *
 * The transport receives exactly the representation that passed the policy
 * check. A string, or a URL-like object (a string `href` and no `url`, which
 * also covers a `URL` created in another realm such as an iframe), is
 * forwarded as its validated absolute `href`. A same-realm `Request` is
 * forwarded unchanged after its immutable `url` validated. Anything else is
 * rejected: a Request-like object that is not a same-realm `Request` would be
 * stringified by native fetch through `toString`, not `url`, so validating its
 * `url` would not cover what is actually fetched.
 */
export function fetchAitAuthority(input: {
  readonly resource: RequestInfo | URL;
  readonly init?: RequestInit;
  readonly fetch?: typeof fetch;
}): Promise<Response> {
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    return Promise.reject(new TypeError('AIT authority fetch is unavailable.'));
  }
  const resolution = resolveAitAuthorityResource(input.resource);
  if (!resolution.ok) {
    return Promise.reject(resolution.error);
  }
  return fetchImplementation(resolution.resource, input.init);
}

const loopbackHostnames = new Set(['localhost', '127.0.0.1']);

type AitAuthorityResourceResolution =
  | { readonly ok: true; readonly resource: RequestInfo }
  | { readonly ok: false; readonly error: TypeError };

function resolveAitAuthorityResource(resource: RequestInfo | URL): AitAuthorityResourceResolution {
  const candidate = readAitAuthorityResourceCandidate(resource);
  if (candidate === undefined) {
    return {
      ok: false,
      error: new TypeError('AIT authority resource must be a string, URL, or same-realm Request.'),
    };
  }
  let url: URL;
  try {
    url = new URL(candidate.href, globalThis.location?.href);
  } catch {
    return {
      ok: false,
      error: new TypeError('AIT authority resource must be an absolute https: URL.'),
    };
  }
  const policyError = checkAitAuthorityUrl(url);
  if (policyError !== undefined) {
    return { ok: false, error: policyError };
  }
  return {
    ok: true,
    resource: candidate.kind === 'request' ? candidate.request : url.href,
  };
}

function checkAitAuthorityUrl(url: URL): TypeError | undefined {
  if (url.protocol === 'https:') {
    return undefined;
  }
  if (url.protocol === 'http:' && loopbackHostnames.has(url.hostname)) {
    return undefined;
  }
  return new TypeError(
    `AIT authority resource must use https: (http: is allowed only for localhost); received ${url.protocol}//${url.host}.`,
  );
}

type AitAuthorityResourceCandidate =
  | { readonly kind: 'href'; readonly href: string }
  | { readonly kind: 'request'; readonly href: string; readonly request: Request };

/**
 * Reads the URL text once so the same value is both validated and forwarded.
 *
 * URL-like objects are recognized by shape (`instanceof URL` is false for a
 * URL from another realm) and forwarded as their href string, so the object
 * itself never reaches the transport. Requests are only accepted via a
 * same-realm `instanceof Request`: the instance must be forwarded as-is, and
 * native fetch stringifies any non-Request object through `toString` rather
 * than reading `url`, so a duck-typed `{ url }` cannot be trusted.
 */
function readAitAuthorityResourceCandidate(resource: unknown): AitAuthorityResourceCandidate | undefined {
  if (typeof resource === 'string') {
    return { kind: 'href', href: resource };
  }
  if (typeof resource !== 'object' || resource === null) {
    return undefined;
  }
  if (typeof Request === 'function' && resource instanceof Request) {
    return { kind: 'request', href: resource.url, request: resource };
  }
  const { href, url } = resource as { readonly href?: unknown; readonly url?: unknown };
  if (typeof href === 'string' && url === undefined) {
    return { kind: 'href', href };
  }
  return undefined;
}
