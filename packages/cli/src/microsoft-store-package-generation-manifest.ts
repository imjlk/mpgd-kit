import { TextDecoder } from 'node:util';

import { formatError } from './evidence-io.js';
import { type MicrosoftStoreFileSnapshot } from './microsoft-store-package-generation-contract.js';
import {
  assertMicrosoftStoreSnapshotUnchanged,
  hashMicrosoftStoreBytes,
  readBoundedMicrosoftStoreFileBytes,
} from './microsoft-store-package-generation-integrity.js';

const maximumManifestBytes = 1024 * 1024;

export function readHashVerifiedMicrosoftStoreManifest(
  file: string,
  expected: MicrosoftStoreFileSnapshot,
): Readonly<Record<string, unknown>> {
  const bytes = readBoundedMicrosoftStoreFileBytes(
    file,
    'Microsoft Store web app manifest',
    maximumManifestBytes,
  );

  if (bytes === null) {
    throw new Error('Microsoft Store web app manifest is too large.');
  }

  if (
    bytes.length !== expected.sizeBytes
    || hashMicrosoftStoreBytes(bytes) !== expected.sha256
  ) {
    throw new Error(`Microsoft Store web app manifest changed while it was read: ${file}`);
  }

  assertMicrosoftStoreSnapshotUnchanged(
    file,
    expected,
    'Microsoft Store web app manifest changed while it was parsed',
  );
  let source: string;

  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Microsoft Store web app manifest must use valid UTF-8: ${formatError(error)}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Failed to parse Microsoft Store web app manifest: ${formatError(error)}`);
  }

  return requireRecord(parsed, 'Microsoft Store web app manifest');
}

export function assertMicrosoftStorePwaUrlInsideManifestScope(
  pwaUrl: string,
  manifestUrl: string,
  manifest: Readonly<Record<string, unknown>>,
): void {
  const scopeInput = requireNonEmptyString(manifest.scope, 'web app manifest scope');
  const parsedManifestUrl = new URL(manifestUrl);
  let scopeUrl: URL;

  try {
    scopeUrl = new URL(scopeInput, parsedManifestUrl);
  } catch {
    throw new Error('Web app manifest scope must resolve against the deployed manifest URL.');
  }

  let parsedPwaUrl: URL;

  try {
    parsedPwaUrl = new URL(pwaUrl);
  } catch {
    throw new Error('Microsoft Store PWA URL must be an absolute URL.');
  }
  const scopePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : `${scopeUrl.pathname}/`;

  if (
    scopeUrl.origin !== parsedManifestUrl.origin
    || parsedPwaUrl.origin !== scopeUrl.origin
    || (
      parsedPwaUrl.pathname !== scopeUrl.pathname
      && !parsedPwaUrl.pathname.startsWith(scopePath)
    )
  ) {
    throw new Error(
      'Microsoft Store PWA URL must stay within the hash-verified web app manifest scope.',
    );
  }
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }

  return input;
}
