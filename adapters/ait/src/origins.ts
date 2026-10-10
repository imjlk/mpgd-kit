/**
 * Browser origins an Apps in Toss mini-app can send requests from.
 *
 * Game backends use this list for an exact CORS allowlist. The `web` pair is
 * used by released and QR-test WebView bundles, and SDK 3.x bundles can also
 * send the `apps` pair. This module is SDK-free and safe to import on a server.
 */
export function aitBrowserOrigins(appName: string): readonly string[] {
  const host = normalizeAitOriginAppName(appName);
  return Object.freeze([
    `https://${host}.web.tossmini.com`,
    `https://${host}.private-web.tossmini.com`,
    `https://${host}.apps.tossmini.com`,
    `https://${host}.private-apps.tossmini.com`,
  ]);
}

/** Exact-match check of a request `Origin` header against `aitBrowserOrigins(appName)`. */
export function isAitBrowserOrigin(appName: string, origin: string | null | undefined): boolean {
  return typeof origin === 'string' && aitBrowserOrigins(appName).includes(origin);
}

function normalizeAitOriginAppName(appName: string): string {
  if (typeof appName !== 'string') {
    throw new TypeError('AIT appName must be a string.');
  }
  // Browsers send lower-case hosts in the Origin header.
  const normalized = appName.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalized)) {
    throw new TypeError(
      'AIT appName must be a DNS label: 1 to 63 letters, numbers or inner hyphens.',
    );
  }
  return normalized;
}
