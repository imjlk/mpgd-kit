import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import type { DevvitInlineBudget } from './schemas';

export interface DevvitInlineGraphFile {
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface DevvitInlineReport {
  readonly entry: string;
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

const dynamicImportPattern = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const staticImportPattern = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']/g;
const htmlAssetPattern = /<(?:script[^>]*\ssrc|link[^>]*\srel=["'](?:modulepreload|stylesheet)["'][^>]*\shref)=["']([^"']+)["']/g;
const htmlAssetPatternReversed = /<link[^>]*\shref=["']([^"']+)["'][^>]*\srel=["'](?:modulepreload|stylesheet)["']/g;
const cssImportPattern = /@import\s+(?:url\(\s*["']?([^\s"')]+)["']?\s*\)|["']([^"']+)["'])/gi;

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
  const entryPath = resolve(root, inlineEntry);
  if (!existsSync(entryPath)) {
    throw new Error(`Devvit inlineEntry ${inlineEntry} does not exist in ${clientDir}.`);
  }
  const html = readFileSync(entryPath, 'utf8');
  const queue: { readonly file: string; readonly dynamic: boolean }[] = [];
  for (const pattern of [htmlAssetPattern, htmlAssetPatternReversed]) {
    for (const match of html.matchAll(pattern)) {
      const reference = match[1];
      if (reference !== undefined && isLocalReference(reference)) {
        queue.push({ file: resolveReference(root, dirname(entryPath), reference), dynamic: false });
      }
    }
  }
  const deferred = deferredChunks.map(globToRegExp);
  const seen = new Set<string>();
  const files: DevvitInlineGraphFile[] = [];
  const forbiddenHits: readonly { module: string; file: string }[] = [];
  const allContents: { path: string; content: string }[] = [];
  while (queue.length > 0) {
    const edge = queue.shift();
    if (edge === undefined || seen.has(edge.file) || !existsSync(edge.file)) {
      continue;
    }
    const { file, dynamic } = edge;
    const filePath = relative(root, file).replace(/\\/gu, '/');
    if (dynamic && deferred.some((pattern) => pattern.test(filePath))) {
      // A later static edge must still include this file in the first load.
      continue;
    }
    seen.add(file);
    const buffer = readFileSync(file);
    files.push({
      path: filePath,
      bytes: buffer.length,
      gzipBytes: gzipSync(buffer, { level: 9 }).length,
    });
    const content = buffer.toString('utf8');
    allContents.push({ path: filePath, content });
    if (file.endsWith('.js') || file.endsWith('.mjs')) {
      for (const [pattern, dynamic] of [
        [staticImportPattern, false],
        [dynamicImportPattern, true],
      ] as const) {
        for (const match of content.matchAll(pattern)) {
          const reference = match[1];
          if (reference !== undefined && isLocalReference(reference)) {
            queue.push({ file: resolveReference(root, dirname(file), reference), dynamic });
          }
        }
      }
    } else if (file.endsWith('.css')) {
      for (const match of content.matchAll(cssImportPattern)) {
        const reference = match[1] ?? match[2];
        if (reference !== undefined && isLocalReference(reference)) {
          queue.push({ file: resolveReference(root, dirname(file), reference), dynamic: false });
        }
      }
    }
  }
  return {
    entry: inlineEntry,
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
  const contents = report.contents;
  if (report.files.length === 0) {
    throw new Error(
      `${input.target} inlineEntry ${input.inlineEntry} references no local scripts.`,
    );
  }
  const hits: { module: string; file: string }[] = [];
  for (const moduleName of input.budget?.forbidModules ?? []) {
    const signature = moduleSignatures[moduleName];
    const namePattern = new RegExp(`(?:^|[/._-])${escapeRegExp(moduleName)}(?:[._-]|$)`, 'i');
    for (const file of contents) {
      if (namePattern.test(file.path.replace(/\.[a-z0-9]+$/i, '')) || signature?.test(file.content) === true) {
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
    files: report.files,
    gzipBytes: report.gzipBytes,
    forbiddenHits: hits,
  };
}

function isLocalReference(reference: string): boolean {
  return !/^(?:[a-z]+:)?\/\//i.test(reference) && !reference.startsWith('data:');
}

function resolveReference(root: string, fromDir: string, reference: string): string {
  const clean = reference.split(/[?#]/)[0] ?? reference;
  return normalize(clean.startsWith('/') ? join(root, clean) : resolve(fromDir, clean));
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '');
  return new RegExp(`^${normalized.split('*').map(escapeRegExp).join('[^/]*')}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
