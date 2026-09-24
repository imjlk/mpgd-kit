import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { withReleaseManifestLock } from './release-manifest-lock';

export interface NativeBuildAttemptRecord {
  readonly target: string;
  readonly runId: string;
  readonly pid: number;
  readonly status: 'building' | 'failed' | 'success';
  readonly artifact?: string;
}

export interface NativeBuildAttempt {
  readonly runId: string;
  complete(artifact: string): void;
  fail(): void;
}

const targetPattern = /^[a-z][a-z0-9-]*$/u;

export function nativeBuildAttemptPath(gameRoot: string, target: string): string {
  if (!targetPattern.test(target)) {
    throw new Error('Native build target name is invalid.');
  }
  return path.join(gameRoot, 'artifacts/native-build-status', `${target}.json`);
}

export function readNativeBuildAttempt(
  gameRoot: string,
  target: string,
): NativeBuildAttemptRecord | undefined {
  const file = nativeBuildAttemptPath(gameRoot, target);
  if (!existsSync(file)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Native build status must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.target !== target || typeof record.runId !== 'string'
    || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 1
    || (record.status !== 'building' && record.status !== 'failed'
      && record.status !== 'success')
    || (record.artifact !== undefined && typeof record.artifact !== 'string')) {
    throw new Error('Native build status is malformed.');
  }
  return record as unknown as NativeBuildAttemptRecord;
}

export function beginNativeBuildAttempt(gameRoot: string, target: string): NativeBuildAttempt {
  const file = nativeBuildAttemptPath(gameRoot, target);
  const record: NativeBuildAttemptRecord = {
    target,
    runId: randomUUID(),
    pid: process.pid,
    status: 'building',
  };
  withReleaseManifestLock(file, () => {
    const previous = readNativeBuildAttempt(gameRoot, target);
    if (previous?.status === 'building' && isProcessAlive(previous.pid)) {
      throw new Error(`Native target ${target} already has a live build.`);
    }
    writeRecord(file, record);
  });

  function settle(status: 'failed' | 'success', artifact?: string): void {
    const current = readNativeBuildAttempt(gameRoot, target);
    if (current?.runId !== record.runId || current.status !== 'building') {
      throw new Error('Native build status was replaced by another attempt.');
    }
    writeRecord(file, { ...record, status, ...(artifact === undefined ? {} : { artifact }) });
  }

  return {
    runId: record.runId,
    complete(artifact) {
      if (!artifact.startsWith(`release-output/native/${target}/`) || path.isAbsolute(artifact)
        || artifact.split(/[\\/]/u).some((segment) => segment === '' || segment === '..')) {
        throw new Error('Native build artifact path is invalid.');
      }
      settle('success', artifact);
    },
    fail() {
      settle('failed');
    },
  };
}

function writeRecord(file: string, record: NativeBuildAttemptRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
