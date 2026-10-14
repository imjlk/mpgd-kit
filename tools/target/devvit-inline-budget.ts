import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { DevvitInlineBudget } from './schemas';
import {
  htmlReferences,
  scriptReferences,
  styleReferences,
  type InlineReference,
} from './devvit-inline-references';

export interface DevvitInlineGraphFile {
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface DevvitInlineReport {
  readonly entry: string;
  readonly externalReferences: readonly string[];
  readonly files: readonly DevvitInlineGraphFile[];
  readonly gzipBytes: number;
  readonly forbiddenHits: readonly { readonly module: string; readonly file: string }[];
}

/** Content signatures for well-known engines that are not identifiable by chunk name alone. */
const moduleSignatures: Readonly<Record<string, RegExp>> = {
  phaser: /Phaser v\d|PHASER_VERSION|\bPhaser\.(?:Game|Scene|AUTO)\b/,
  'matter-js': /matter-js@|Matter\.Engine\b/,
  pixi: /PIXI\.Application|pixi\.js/,
  three: /REVISION\s*=\s*["']\d+["'].*three/,
};

/**
 * Walk the inline entry's load graph: HTML scripts, modulepreloads and
 * stylesheets, static `import`/`export from` edges, and dynamic `import()`
 * edges (an inline entry often awaits its surface router dynamically).
 * Dynamically imported chunks matching `deferredChunks` are boundaries: neither they nor what is
 * reachable only through them count toward the inline first load.
 */
export function collectDevvitInlineGraph(
  clientDir: string,
  inlineEntry: string,
  deferredChunks: readonly string[] = [],
): DevvitInlineReport {
  const { contents: _contents, ...report } = walkInlineGraph(
    clientDir,
    inlineEntry,
    deferredChunks,
  );
  return report;
}

function walkInlineGraph(
  clientDir: string,
  inlineEntry: string,
  deferredChunks: readonly string[],
): DevvitInlineReport & { readonly contents: readonly { readonly path: string; readonly content: string }[] } {
  const root = resolve(clientDir);
  if (isAbsolute(inlineEntry)) {
    throw new Error('Devvit inlineEntry must be relative to the client artifact.');
  }
  const entryPath = resolve(root, inlineEntry);
  assertClientPath(root, entryPath);
  if (!existsSync(entryPath)) {
    throw new Error(`Devvit inlineEntry ${inlineEntry} does not exist in ${clientDir}.`);
  }
  const html = readFileSync(entryPath, 'utf8');
  const queue: { readonly file: string; readonly key: string; readonly dynamic: boolean }[] = [];
  const externalReferences = new Set<string>();
  const enqueue = (references: readonly InlineReference[], fromDir: string): void => {
    for (const { url, dynamic } of references) {
      const reference = url.trim();
      if (reference === '' || reference.startsWith('#') || /^data:/iu.test(reference)) {
        continue;
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(reference)) {
        externalReferences.add(reference);
        continue;
      }
      const file = resolveReference(root, fromDir, reference);
      const query = reference.match(/\?[^#]*/u)?.[0] ?? '';
      queue.push({ file, key: file + query, dynamic });
    }
  };
  enqueue(htmlReferences(html), dirname(entryPath));
  const deferred = deferredChunks.map(globToRegExp);
  const seen = new Set<string>([entryPath]);
  const entryBytes = Buffer.from(html);
  const entryName = relative(root, entryPath).replace(/\\/gu, '/');
  const files: DevvitInlineGraphFile[] = [
    {
      path: entryName,
      bytes: entryBytes.length,
      gzipBytes: gzipSync(entryBytes, { level: 9 }).length,
    },
  ];
  const forbiddenHits: readonly { module: string; file: string }[] = [];
  const allContents: { path: string; content: string }[] = [{ path: entryName, content: html }];
  while (queue.length > 0) {
    const edge = queue.shift();
    if (edge === undefined || seen.has(edge.key)) {
      continue;
    }
    assertClientPath(root, edge.file);
    if (!existsSync(edge.file)) {
      throw new Error(`Devvit inline dependency ${edge.file} does not exist.`);
    }
    const { file, dynamic } = edge;
    const filePath = relative(root, file).replace(/\\/gu, '/');
    if (dynamic && deferred.some((pattern) => pattern.test(filePath))) {
      // A later static edge must still include this file in the first load.
      continue;
    }
    seen.add(edge.key);
    const resourcePath = filePath + edge.key.slice(file.length);
    const buffer = readFileSync(file);
    files.push({
      path: resourcePath,
      bytes: buffer.length,
      gzipBytes: gzipSync(buffer, { level: 9 }).length,
    });
    const content = buffer.toString('utf8');
    allContents.push({ path: resourcePath, content });
    if (file.endsWith('.js') || file.endsWith('.mjs')) {
      enqueue(scriptReferences(content), dirname(file));
    } else if (file.endsWith('.css')) {
      enqueue(styleReferences(content), dirname(file));
    }
  }

  return {
    entry: inlineEntry,
    externalReferences: [...externalReferences].sort(),
    files,
    gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    forbiddenHits,
    contents: allContents,
  };
}

export function assertDevvitInlineBudget(input: {
  readonly target: string;
  readonly clientDir: string;
  readonly inlineEntry: string;
  readonly budget?: DevvitInlineBudget;
}): DevvitInlineReport {
  const report = walkInlineGraph(
    input.clientDir,
    input.inlineEntry,
    input.budget?.deferredChunks ?? [],
  );
  if (input.budget !== undefined && report.externalReferences.length > 0) {
    throw new Error('Devvit inline budget cannot verify external first-load resources: '
      + report.externalReferences.join(', ') + '. Bundle these resources into the client artifact.');
  }
  const contents = report.contents;
  const hits: { module: string; file: string }[] = [];
  for (const moduleName of input.budget?.forbidModules ?? []) {
    const signature = moduleSignatures[moduleName];
    const namePattern = new RegExp(`(?:^|[/._-])${escapeRegExp(moduleName)}(?:[._-]|$)`, 'i');
    for (const file of contents) {
      const pathname = file.path.split('?')[0] ?? file.path;
      if (namePattern.test(pathname.replace(/\.[a-z0-9]+$/i, '')) || signature?.test(file.content) === true) {
        hits.push({ module: moduleName, file: file.path });
      }
    }
  }
  if (hits.length > 0) {
    throw new Error(
      `${input.target} inline entry statically loads forbidden module(s): `
        + hits.map((hit) => `${hit.module} in ${hit.file}`).join(', ')
        + '. Load them with dynamic import() from the expanded surface instead.',
    );
  }
  const maxGzipKb = input.budget?.maxGzipKb;
  if (maxGzipKb !== undefined && report.gzipBytes > maxGzipKb * 1024) {
    throw new Error(
      `${input.target} inline entry first-load gzip size ${(report.gzipBytes / 1024).toFixed(1)} KiB `
        + `exceeds inlineBudget.maxGzipKb ${maxGzipKb} KiB (${report.files.map((file) => file.path).join(', ')}).`,
    );
  }
  return {
    entry: report.entry,
    externalReferences: report.externalReferences,
    files: report.files,
    gzipBytes: report.gzipBytes,
    forbiddenHits: hits,
  };
}

function resolveReference(root: string, fromDir: string, reference: string): string {
  const clean = decodeURIComponent(reference.split(/[?#]/)[0] ?? reference);
  return normalize(clean.startsWith('/') ? join(root, clean) : resolve(fromDir, clean));
}

function assertClientPath(root: string, file: string): void {
  const fromRoot = relative(root, file).replace(/\\/gu, '/');
  if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
    throw new Error(`Devvit inline path ${file} escapes the client artifact.`);
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '');
  return new RegExp(`^${normalized.split('*').map(escapeRegExp).join('[^/]*')}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
