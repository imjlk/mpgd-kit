import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runReleaseProcess } from './deploy-process.js';
import { isolatedAscEnvironment, verifyPinnedAscBinary } from './testflight-submission.js';

/**
 * One session on the pinned `asc` 5.5.0 CLI, with the same binary pin,
 * isolated environment and API key as the TestFlight submission, and the
 * JSON helpers every asc-backed port reads its output with. Each command is
 * one `asc ... --output json` subprocess; the JSON is App Store Connect's
 * own resource document, as `asc` received it
 * (`internal/asc/types/resources.go` at the 5.5.0 tag).
 */

/** Runs one asc command with `--output json` appended and returns the parsed JSON. */
export type AscCommandRunner = (args: readonly string[], timeoutMs: number) => Promise<unknown>;

export interface AscCredential {
  readonly ascBinary: string;
  readonly apiKeyId: string;
  readonly apiIssuerId: string;
  readonly apiPrivateKeyBase64: string;
}

export const ascLookupTimeoutMs = 60_000;
export const ascListTimeoutMs = 3 * 60_000;
export const ascUploadTimeoutMs = 10 * 60_000;
const maxJsonBytes = 8 * 1024 * 1024;
/** asc exit code for an App Store Connect 404 (`cmd/exit_codes.go`, 5.5.0). */
export const ascExitNotFound = 4;

/**
 * Copy and verify the pinned binary into a private directory; `close` removes
 * it. `extraSecretValues` are redacted from asc output like the API key (for
 * example a TestFlight review demo account password).
 */
export async function openAscSession(
  credential: AscCredential,
  signal?: AbortSignal,
  extraSecretValues: readonly string[] = [],
): Promise<{ readonly run: AscCommandRunner; close(): void }> {
  if (!path.isAbsolute(credential.ascBinary)) {
    throw new Error('asc binary must be an absolute file path.');
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-asc-iap-'));
  try {
    const binary = path.join(tempRoot, 'asc');
    copyFileSync(credential.ascBinary, binary);
    chmodSync(binary, 0o700);
    await verifyPinnedAscBinary(binary);
    const environment = isolatedAscEnvironment(credential, tempRoot);
    const run: AscCommandRunner = async (args, timeoutMs) => {
      const result = await runReleaseProcess({
        command: binary,
        args: [...args, '--output', 'json'],
        cwd: tempRoot,
        environment,
        timeoutMs,
        maxOutputBytes: maxJsonBytes,
        captureMachineStdout: true,
        secretValues: [
          credential.apiKeyId,
          credential.apiIssuerId,
          credential.apiPrivateKeyBase64,
          ...extraSecretValues.filter((value) => value !== ''),
        ],
        signal,
      });
      if (result.truncated || result.machineStdout === undefined) {
        throw new Error('asc JSON output was truncated or unavailable.');
      }
      try {
        return JSON.parse(result.machineStdout) as unknown;
      } catch {
        throw new Error('asc returned invalid JSON.');
      }
    };
    return {
      run,
      close: () => rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export interface AscJsonResource {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
  readonly relationships?: unknown;
}

export function single(value: unknown, command: string): AscJsonResource {
  const resource = isRecord(value) ? toResource(value.data) : undefined;
  if (resource === undefined) {
    throw new Error(`asc ${command} returned no resource.`);
  }
  return resource;
}

export function list(value: unknown, command: string): AscJsonResource[] {
  const resources = isRecord(value) && Array.isArray(value.data)
    ? value.data.map(toResource)
    : undefined;
  if (resources === undefined || resources.some((resource) => resource === undefined)) {
    throw new Error(`asc ${command} returned no resource list.`);
  }
  return resources as AscJsonResource[];
}

export function toResource(value: unknown): AscJsonResource | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') {
    return undefined;
  }
  return {
    id: value.id,
    attributes: isRecord(value.attributes) ? value.attributes : {},
    ...(value.relationships === undefined ? {} : { relationships: value.relationships }),
  };
}

/**
 * App Store Connect's `data: null`, or asc's rendering of it: asc 5.5.0
 * decodes into a non-pointer resource and prints `{ "type": "", "id": "" }`.
 */
export function isEmptyResource(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.data === null
    || (isRecord(value.data) && (value.data.id === undefined || value.data.id === ''));
}

export function relationshipId(relationships: unknown, name: string): string | undefined {
  if (!isRecord(relationships)) {
    return undefined;
  }
  const relationship = relationships[name];
  if (!isRecord(relationship) || !isRecord(relationship.data)) {
    return undefined;
  }
  return typeof relationship.data.id === 'string' ? relationship.data.id : undefined;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`asc output has no ${label}.`);
  }
  return value;
}

export function optionalString<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  if (typeof value === 'string' && value !== '') {
    result[key] = value;
  }
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
