import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const embeddedTargetConfigFileName = 'mpgd-effective-target.json';

export interface EmbeddedTargetConfigEvidence {
  readonly label: string;
  readonly source: string;
  readonly content: string;
  readonly digest: string;
  readonly target: string | undefined;
  readonly version: string | undefined;
}

export function readEmbeddedTargetConfigFromFile(
  path: string,
  label: string,
): EmbeddedTargetConfigEvidence {
  assertPathExists(path, label);

  return createEvidence(label, path, readFileSync(path, 'utf8'));
}

export function readEmbeddedTargetConfigFromDirectory(
  root: string,
  label: string,
): EmbeddedTargetConfigEvidence {
  assertPathExists(root, label);

  const path = findEmbeddedTargetConfig(root);

  if (path === undefined) {
    throw new Error(`Missing embedded target config in ${label}: ${root}`);
  }

  return readEmbeddedTargetConfigFromFile(path, label);
}

export function readEmbeddedTargetConfigFromZip(
  path: string,
  label: string,
): EmbeddedTargetConfigEvidence {
  assertPathExists(path, label);

  const entries = captureZipStdout('unzip', ['-Z1', path]).split('\n');
  const entry = entries.find((candidate) => basename(candidate) === embeddedTargetConfigFileName);

  if (entry === undefined) {
    throw new Error(`Missing embedded target config in ${label}: ${path}`);
  }

  return createEvidence(label, `${path}:${entry}`, captureZipStdout('unzip', ['-p', path, entry]));
}

export function assertEmbeddedTargetConfig(
  evidence: EmbeddedTargetConfigEvidence,
  expected: {
    readonly target: string;
    readonly digest?: string;
  },
): void {
  if (evidence.target !== expected.target) {
    throw new Error(
      `${evidence.label} points to effective config for ${String(
        evidence.target,
      )}; expected ${expected.target}.`,
    );
  }

  if (expected.digest !== undefined && evidence.digest !== expected.digest) {
    throw new Error(`${evidence.label} embedded target config digest mismatch.`);
  }
}

function createEvidence(
  label: string,
  source: string,
  content: string,
): EmbeddedTargetConfigEvidence {
  const parsed = JSON.parse(content) as {
    readonly target?: string;
    readonly version?: string;
  };

  return {
    label,
    source,
    content,
    digest: sha256(content),
    target: parsed.target,
    version: parsed.version,
  };
}

function findEmbeddedTargetConfig(root: string): string | undefined {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isFile() && entry === embeddedTargetConfigFileName) {
      return path;
    }

    if (!stat.isDirectory()) {
      continue;
    }

    const found = findEmbeddedTargetConfig(path);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function captureZipStdout(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    const detail = stderr.length > 0 ? `: ${stderr}` : '.';
    const message = `${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`;

    throw new Error(message);
  }

  return result.stdout;
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
