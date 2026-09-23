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
  return fetchImplementation(input.resource, input.init);
}
