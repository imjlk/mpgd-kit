import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

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

export function readArtifactTextFromDirectory(
  root: string,
  artifactPath: string,
  label: string,
): { readonly source: string; readonly content: string } {
  assertPathExists(root, label);
  const portablePath = requirePortableArtifactPath(artifactPath);
  const path = resolve(root, portablePath);
  assertPathExists(path, `${label} icon manifest`);
  const resolvedRoot = realpathSync(root);
  const resolvedPath = realpathSync(path);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Artifact path escapes ${label}: ${artifactPath}`);
  }

  return { source: resolvedPath, content: readFileSync(resolvedPath, 'utf8') };
}

export function readArtifactTextFromZip(
  path: string,
  artifactPath: string,
  label: string,
): { readonly source: string; readonly content: string } {
  assertPathExists(path, label);
  const portablePath = requirePortableArtifactPath(artifactPath);
  const entries = captureZipStdout('unzip', ['-Z1', path]).split('\n');
  const matches = entries.filter((candidate) => candidate === portablePath);

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${portablePath} in ${label}; found ${matches.length}: ${path}`,
    );
  }

  return {
    source: `${path}:${portablePath}`,
    content: captureZipStdout('unzip', ['-p', path, portablePath]),
  };
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
  return findNamedFile(root, embeddedTargetConfigFileName);
}

function findNamedFile(root: string, fileName: string): string | undefined {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isFile() && entry === fileName) {
      return path;
    }

    if (!stat.isDirectory()) {
      continue;
    }

    const found = findNamedFile(path, fileName);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function requirePortableArtifactPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');

  if (
    normalized.length === 0
    || isAbsolute(path)
    || isAbsolute(normalized)
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`Invalid artifact path: ${path}`);
  }

  return normalized;
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
    const tolerated =
      result.status !== null
      && isToleratedZipPrefixWarning(command, args, result.status, result.stderr);

    if (result.stdout.trim().length !== 0 && tolerated) {
      return result.stdout;
    }

    const stderr = result.stderr.trim();
    const detail = stderr.length > 0 ? `: ${stderr}` : '.';
    const status =
      result.status === null
        ? `signal ${result.signal ?? 'unknown'}`
        : `exit code ${result.status}`;
    const message = `${command} ${args.join(' ')} failed with ${status}${detail}`;

    throw new Error(message);
  }

  return result.stdout;
}

function isToleratedZipPrefixWarning(
  command: string,
  args: readonly string[],
  status: number,
  stderr: string,
): boolean {
  if (command !== 'unzip' || status !== 1) {
    return false;
  }

  const mode = args[0];

  return (
    (mode === '-Z1' || mode === '-p')
    && stderr.includes('extra bytes at beginning or within zipfile')
    && stderr.includes('(attempting to process anyway)')
  );
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
