import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Content Security Policy for the Capacitor WebView shell page.
 *
 * The staged game bundle is a plain Vite output (external module script and
 * stylesheet), so scripts stay first-party. 'wasm-unsafe-eval' mirrors the
 * offline playtest policy, blob: workers and media cover Phaser audio/worker
 * usage, and connect-src keeps the authenticated game backend reachable over
 * TLS while blocking plaintext origins. frame-ancestors is omitted because
 * browsers ignore it in a <meta> policy.
 */
export const capacitorShellContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const metaTagPattern = /<meta\b[^>]*>/giu;
const httpEquivPattern = /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;
const headOpenPattern = /<head\b[^>]*>/iu;

/**
 * Whether the page already carries an enforcing CSP meta tag. The http-equiv
 * value must match exactly (ASCII case-insensitive, quoted or unquoted), the
 * same way browsers process it: Content-Security-Policy-Report-Only or a value
 * with stray characters does not enforce anything and must not suppress the
 * shell policy.
 */
export function hasEnforcingCspMeta(html: string): boolean {
  for (const [tag] of html.matchAll(metaTagPattern)) {
    const httpEquiv = httpEquivPattern.exec(tag);
    if (httpEquiv === null) {
      continue;
    }
    const value = httpEquiv[1] ?? httpEquiv[2] ?? httpEquiv[3] ?? '';
    if (value.toLowerCase() === 'content-security-policy') {
      return true;
    }
  }
  return false;
}

export const capacitorShellCspMetaTag =
  `<meta http-equiv="Content-Security-Policy" content="${capacitorShellContentSecurityPolicy}">`;

/**
 * Insert the shell CSP right after <head>. A page that already declares an
 * enforcing Content-Security-Policy meta tag keeps its game-owned policy
 * untouched; a report-only policy is kept alongside the injected one.
 */
export function injectCapacitorShellCsp(html: string): string {
  if (hasEnforcingCspMeta(html)) {
    return html;
  }
  const head = headOpenPattern.exec(html);
  if (head === null) {
    throw new Error('Capacitor shell index.html must contain a <head> element for its CSP.');
  }
  const insertAt = head.index + head[0].length;
  return `${html.slice(0, insertAt)}\n${capacitorShellCspMetaTag}${html.slice(insertAt)}`;
}

/** Apply the shell CSP to the staged web bundle before cap sync copies it. */
export function applyCapacitorShellCsp(webDir: string): void {
  const indexFile = path.join(webDir, 'index.html');
  if (!existsSync(indexFile) || lstatSync(indexFile).isSymbolicLink()) {
    throw new Error('Capacitor shell web bundle must contain a regular index.html.');
  }
  const html = readFileSync(indexFile, 'utf8');
  const hardened = injectCapacitorShellCsp(html);
  if (hardened !== html) {
    writeFileSync(indexFile, hardened);
  }
}
