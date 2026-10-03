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
  const policyError = checkAitAuthorityResource(input.resource);
  if (policyError !== undefined) {
    return Promise.reject(policyError);
  }
  return fetchImplementation(input.resource, input.init);
}

const loopbackHostnames = new Set(['localhost', '127.0.0.1']);

function checkAitAuthorityResource(resource: RequestInfo | URL): TypeError | undefined {
  let url: URL;
  try {
    url = new URL(readResourceUrl(resource), globalThis.location?.href);
  } catch {
    return new TypeError('AIT authority resource must be an absolute https: URL.');
  }
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

function readResourceUrl(resource: RequestInfo | URL): string {
  if (typeof resource === 'string') {
    return resource;
  }
  if (resource instanceof URL) {
    return resource.href;
  }
  return resource.url;
}
