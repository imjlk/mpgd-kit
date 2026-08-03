import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { PlatformTargetConfig } from './schemas';

const installableManifestNames = new Set(['manifest.json', 'manifest.webmanifest']);
const reservedGeneratedEvidenceNames = new Set([
  'mpgd-effective-target.json',
  'mpgd-icon-manifest.json',
  'mpgd-icon-precache.json',
]);
const relAttributePattern = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

export interface NamedWebArtifactOutput {
  readonly name: string;
  readonly path: string;
}

interface HtmlTagRange {
  readonly end: number;
  readonly start: number;
  readonly tag: string;
}

interface HtmlHeadScan {
  readonly closingTagStart?: number;
  readonly linkTags: readonly HtmlTagRange[];
}

export function copyWebStaticDirectoryContents(
  source: string,
  destination: string,
): void {
  mkdirSync(destination, { recursive: true });
  copyDirectoryContents(source, destination);
}

export function sanitizeNonInstallableWebArtifact(artifactRoot: string): void {
  for (const manifest of rootInstallableManifests(artifactRoot)) {
    rmSync(manifest, { force: true });
  }

  const indexFile = join(artifactRoot, 'index.html');
  if (!existsSync(indexFile)) {
    return;
  }

  const source = readFileSync(indexFile, 'utf8');
  const sanitized = stripManifestLinkTags(source);

  if (sanitized !== source) {
    writeFileSync(indexFile, sanitized);
  }
}

export function ensureInstallableWebManifestLink(artifactRoot: string): void {
  const indexFile = join(artifactRoot, 'index.html');
  if (!existsSync(indexFile)) {
    return;
  }

  const source = readFileSync(indexFile, 'utf8');
  const link = '<link rel="manifest" href="./manifest.webmanifest">';
  const existingManifestLinks = manifestLinkTags(source);

  if (existingManifestLinks.length === 1 && existingManifestLinks[0] === link) {
    return;
  }

  const withoutManifestLinks = stripManifestLinkTags(source);
  const closingHeadTag = scanHtmlHead(withoutManifestLinks).closingTagStart;
  const linked = closingHeadTag === undefined
    ? `${link}\n${withoutManifestLinks}`
    : withoutManifestLinks.slice(0, closingHeadTag)
      + `  ${link}\n`
      + withoutManifestLinks.slice(closingHeadTag);

  writeFileSync(indexFile, linked);
}

export function assertNonInstallableWebArtifact(artifactRoot: string): void {
  const manifests = rootInstallableManifests(artifactRoot);
  if (manifests.length > 0) {
    throw new Error(
      `Non-installable web artifact contains a web app manifest: ${manifests.join(', ')}`,
    );
  }

  const indexFile = join(artifactRoot, 'index.html');
  if (existsSync(indexFile) && indexHtmlLinksManifest(indexFile)) {
    throw new Error(`Non-installable web artifact links a web app manifest: ${indexFile}`);
  }
}

export function assertInstallableWebArtifact(artifactRoot: string): void {
  const manifests = rootInstallableManifests(artifactRoot);
  if (manifests.length === 0) {
    throw new Error(`Installable web artifact has no web app manifest: ${artifactRoot}`);
  }

  const indexFile = join(artifactRoot, 'index.html');
  if (!existsSync(indexFile) || !indexHtmlLinksManifest(indexFile)) {
    throw new Error(`Installable web artifact does not link a web app manifest: ${indexFile}`);
  }
}

export function assertWebStaticDirectory(
  source: string,
  destination: string,
  owningRoot: string,
): void {
  if (!existsSync(source)) {
    throw new Error(`Web staticDir does not exist: ${source}`);
  }

  const sourceStatus = lstatSync(source);
  if (sourceStatus.isSymbolicLink()) {
    throw new Error(`Refusing to copy a symbolic-link web staticDir: ${source}`);
  }
  if (!sourceStatus.isDirectory()) {
    throw new Error(`Web staticDir must be a directory: ${source}`);
  }

  const canonicalRoot = realpathSync(owningRoot);
  const canonicalSource = realpathSync(source);
  if (!isPathWithin(canonicalRoot, canonicalSource)) {
    throw new Error(`Web staticDir must stay inside its game root: ${source}`);
  }

  const canonicalDestination = canonicalizeWebArtifactOutput(destination);
  if (pathsOverlap(canonicalSource, canonicalDestination)) {
    throw new Error(`Web staticDir and output must not overlap: ${source} and ${destination}`);
  }
}

export function assertWebArtifactOutputDirectory(
  output: string,
  viteOutput: string,
): void {
  const canonicalOutput = canonicalizeWebArtifactOutput(output);
  const canonicalViteOutput = canonicalizeThroughExistingAncestor(viteOutput);

  if (pathsOverlap(canonicalOutput, canonicalViteOutput)) {
    throw new Error(
      `Web artifact output and Vite output must not overlap: ${output} and ${viteOutput}`,
    );
  }
}

export function assertDisjointWebArtifactOutputs(
  outputs: readonly NamedWebArtifactOutput[],
): void {
  const canonicalOutputs = outputs.map((output) => ({
    ...output,
    canonicalPath: canonicalizeWebArtifactOutput(output.path),
  }));

  for (const [index, output] of canonicalOutputs.entries()) {
    for (const candidate of canonicalOutputs.slice(index + 1)) {
      if (pathsOverlap(output.canonicalPath, candidate.canonicalPath)) {
        throw new Error(
          `Web artifact outputs must not overlap: ${output.name} (${output.path}) and ${candidate.name} (${candidate.path}).`,
        );
      }
    }
  }
}

export function assertDisjointWebTargetOutputs(
  targets: Readonly<Record<string, PlatformTargetConfig>>,
  resolvePath: (path: string) => string,
  protectedOutputs: readonly NamedWebArtifactOutput[] = [],
): void {
  const outputs = Object.entries(targets)
    .flatMap(([name, target]) => target.kind === 'web'
      ? [{ name, path: resolvePath(target.output) }]
      : []);

  assertDisjointWebArtifactOutputs(outputs);
  assertWebOutputsAvoidProtectedPaths(
    outputs,
    [...defaultProtectedBuildOutputs(resolvePath), ...configuredProtectedBuildOutputs(
      targets,
      resolvePath,
    ), ...protectedOutputs],
  );
}

function copyDirectoryContents(source: string, destination: string): void {
  for (const entry of readdirSync(source)) {
    if (reservedGeneratedEvidenceNames.has(entry.toLowerCase())) {
      throw new Error(`Web staticDir contains reserved generated evidence: ${entry}`);
    }

    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    const stats = lstatSync(sourcePath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to copy a symbolic link from web staticDir: ${sourcePath}`);
    }

    if (stats.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true });
      copyDirectoryContents(sourcePath, destinationPath);
    } else {
      cpSync(sourcePath, destinationPath);
    }
  }
}

function rootInstallableManifests(artifactRoot: string): string[] {
  return existsSync(artifactRoot)
    ? readdirSync(artifactRoot)
      .filter((entry) => installableManifestNames.has(entry.toLowerCase()))
      .map((entry) => join(artifactRoot, entry))
    : [];
}

function isManifestLinkTag(tag: string): boolean {
  const match = relAttributePattern.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.split(/\s+/u).some((token) => token.toLowerCase() === 'manifest') ?? false;
}

function indexHtmlLinksManifest(indexFile: string): boolean {
  return manifestLinkTags(readFileSync(indexFile, 'utf8')).length > 0;
}

function stripManifestLinkTags(html: string): string {
  const manifestLinks = scanHtmlHead(html).linkTags.filter(({ tag }) => isManifestLinkTag(tag));

  return manifestLinks.reduceRight(
    (result, link) => result.slice(0, link.start) + result.slice(link.end),
    html,
  );
}

function manifestLinkTags(html: string): readonly string[] {
  return scanHtmlHead(html).linkTags.map(({ tag }) => tag).filter(isManifestLinkTag);
}

function scanHtmlHead(html: string): HtmlHeadScan {
  const lowercaseHtml = html.toLowerCase();
  const linkTags: HtmlTagRange[] = [];
  let closingTagStart: number | undefined;
  let inHead = false;
  let index = 0;
  let rawTextTag: 'script' | 'style' | undefined;
  let templateDepth = 0;

  while (index < html.length) {
    if (rawTextTag !== undefined) {
      const closingRawTextTag = lowercaseHtml.indexOf(`</${rawTextTag}`, index);
      if (closingRawTextTag < 0) {
        break;
      }

      index = closingRawTextTag;
      rawTextTag = undefined;
    }

    const tagStart = html.indexOf('<', index);
    if (tagStart < 0) {
      break;
    }

    if (lowercaseHtml.startsWith('<!--', tagStart)) {
      index = skipDelimitedSection(lowercaseHtml, tagStart + 4, '-->');
      continue;
    }

    if (lowercaseHtml.startsWith('<![cdata[', tagStart)) {
      index = skipDelimitedSection(lowercaseHtml, tagStart + 9, ']]>');
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd === undefined) {
      break;
    }

    const parsedTag = parseHtmlTag(html.slice(tagStart + 1, tagEnd));
    index = tagEnd + 1;

    if (parsedTag === undefined) {
      continue;
    }

    const { closing, name, selfClosing } = parsedTag;
    if (closing) {
      if (name === 'template' && inHead && templateDepth > 0) {
        templateDepth -= 1;
      } else if (name === 'head' && inHead && templateDepth === 0) {
        closingTagStart = tagStart;
        inHead = false;
      }

      continue;
    }

    if (name === 'head' && !inHead) {
      inHead = true;
      continue;
    }

    if (!inHead) {
      continue;
    }

    if (name === 'template') {
      if (!selfClosing) {
        templateDepth += 1;
      }
      continue;
    }

    if (!selfClosing && (name === 'script' || name === 'style')) {
      rawTextTag = name;
      continue;
    }

    if (templateDepth > 0) {
      continue;
    }

    if (name === 'link') {
      linkTags.push({
        end: tagEnd + 1,
        start: tagStart,
        tag: html.slice(tagStart, tagEnd + 1),
      });
    }
  }

  return {
    ...(closingTagStart === undefined ? {} : { closingTagStart }),
    linkTags,
  };
}

function skipDelimitedSection(html: string, start: number, delimiter: string): number {
  const end = html.indexOf(delimiter, start);
  return end < 0 ? html.length : end + delimiter.length;
}

function findHtmlTagEnd(html: string, start: number): number | undefined {
  let quote: '"' | "'" | undefined;

  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }

  return undefined;
}

function parseHtmlTag(
  source: string,
): { readonly closing: boolean; readonly name: string; readonly selfClosing: boolean } | undefined {
  const trimmedSource = source.trim();
  const closing = trimmedSource.startsWith('/');
  const tagSource = closing ? trimmedSource.slice(1).trimStart() : trimmedSource;
  const name = /^[a-z][a-z0-9:-]*/iu.exec(tagSource)?.[0]?.toLowerCase();

  return name === undefined
    ? undefined
    : {
        closing,
        name,
        selfClosing: !closing && tagSource.trimEnd().endsWith('/'),
      };
}

function defaultProtectedBuildOutputs(
  resolvePath: (path: string) => string,
): readonly NamedWebArtifactOutput[] {
  return [
    { name: 'AIT release output', path: resolvePath('release-output/ait') },
    { name: 'Android release output', path: resolvePath('release-output/android') },
    { name: 'iOS release output', path: resolvePath('release-output/ios') },
    {
      name: 'iOS simulator build output',
      path: resolvePath('release-output/ios-simulator-build'),
    },
  ];
}

function configuredProtectedBuildOutputs(
  targets: Readonly<Record<string, PlatformTargetConfig>>,
  resolvePath: (path: string) => string,
): readonly NamedWebArtifactOutput[] {
  return Object.entries(targets).flatMap(([name, target]) => {
    switch (target.kind) {
      case 'web':
        return [];
      case 'capacitor-android':
      case 'capacitor-ios':
        return [{ name: `${name} web staging output`, path: resolvePath(target.webDir) }];
      case 'apps-in-toss':
      case 'devvit-web':
        return [
          { name: `${name} web staging output`, path: resolvePath(target.webDir) },
          {
            name: `${name} wrapper build output`,
            path: resolvePath(join(target.wrapperApp, 'dist')),
          },
        ];
    }
  });
}

function assertWebOutputsAvoidProtectedPaths(
  outputs: readonly NamedWebArtifactOutput[],
  protectedOutputs: readonly NamedWebArtifactOutput[],
): void {
  const canonicalProtectedOutputs = protectedOutputs.map((output) => ({
    ...output,
    canonicalPath: canonicalizeThroughExistingAncestor(output.path),
  }));

  for (const output of outputs) {
    const canonicalOutput = canonicalizeWebArtifactOutput(output.path);
    for (const protectedOutput of canonicalProtectedOutputs) {
      if (pathsOverlap(canonicalOutput, protectedOutput.canonicalPath)) {
        throw new Error(
          `Web artifact output must not overlap generated output: ${output.name} (${output.path}) and ${protectedOutput.name} (${protectedOutput.path}).`,
        );
      }
    }
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathWithin(first, second) || isPathWithin(second, first);
}

function canonicalizeWebArtifactOutput(path: string): string {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Web artifact output must not be a symbolic link: ${path}`);
  }

  return canonicalizeThroughExistingAncestor(path);
}

function canonicalizeThroughExistingAncestor(path: string): string {
  const normalizedPath = resolve(path);
  const suffix: string[] = [];
  let existingAncestor = normalizedPath;

  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Cannot resolve an existing ancestor for web output: ${path}`);
    }

    suffix.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  return resolve(realpathSync(existingAncestor), ...suffix);
}
