import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNonInstallableWebArtifact } from './web-artifact';

export const onePlayFrameAncestors = 'https://*.onestore.co.kr https://*.onestore.net';
/** _headers is consumed by compatible static hosts; other hosts must apply the HTTP header explicitly. */
export function writeOnePlayHostingHeaders(root: string): void {
  const path = join(root, '_headers');
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `/*\n  Content-Security-Policy: frame-ancestors ${onePlayFrameAncestors}\n`,
    );
  }
  assertOnePlayArtifact(root);
}
export function assertOnePlayArtifact(root: string): void {
  assertNonInstallableWebArtifact(root);
  const headers = readFileSync(join(root, '_headers'), 'utf8');
  let rule = '';
  let allowed = false;
  for (const line of headers.split(/\r?\n/u)) {
    if (/^\S/u.test(line) && !line.startsWith('#')) {
      rule = line.trim();
    }
    const policy = /^\s+Content-Security-Policy:\s*(.+)$/iu.exec(line)?.[1];
    const directive = policy === undefined
      ? undefined
      : /(?:^|;)\s*frame-ancestors\s+([^;]+)/iu.exec(policy)?.[1];
    const origins = directive?.trim().split(/\s+/u);
    if (rule === '/*' && origins?.includes('https://*.onestore.co.kr') && origins.includes('https://*.onestore.net') && !origins.includes("'none'")) {
      allowed = true;
    }
  }
  if (!allowed) {
    throw new Error('ONE play hosting headers must allow both ONE store domain families.');
  }
  // Prevent contradictory game-owned hosting rules. Inspect final CDN/WAF responses before registration.
  if (/x-frame-options\s*:\s*(?:deny|sameorigin)/iu.test(headers)) {
    throw new Error('ONE play hosting headers contain a conflicting X-Frame-Options rule.');
  }
}
