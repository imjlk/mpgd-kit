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

import { generatedIconCacheDirectory } from '../icons/types';
import type { PlatformTargetConfig } from './schemas';

const installableManifestNames = new Set(['manifest.json', 'manifest.webmanifest']);
const reservedGeneratedEvidenceNames = new Set([
  'mpgd-effective-target.json',
  'mpgd-icon-manifest.json',
  'mpgd-icon-precache.json',
]);

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
  readonly headOpeningTagEnd?: number;
  readonly htmlOpeningTagEnd?: number;
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
  const linked = insertHtmlHeadTag(withoutManifestLinks, link);

  writeFileSync(indexFile, linked);
}

export function ensureWebFaviconLink(artifactRoot: string, href: string): void {
  const indexFile = join(artifactRoot, 'index.html');
  if (!existsSync(indexFile)) {
    return;
  }

  const source = readFileSync(indexFile, 'utf8');
  const link = `<link rel="icon" type="image/png" href="${href}">`;
  const hasFaviconLink = scanHtmlHead(source).linkTags.some(({ tag }) => {
    return isFaviconLinkTag(tag, href);
  });

  if (!hasFaviconLink) {
    writeFileSync(indexFile, insertHtmlHeadTag(source, link));
  }
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
  if (!existsSync(indexFile) || !indexHtmlLinksExistingManifest(indexFile, manifests)) {
    throw new Error(
      `Installable web artifact does not link an existing root web app manifest: ${indexFile}`,
    );
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

  assertWebOutputsStayWithinRoot(outputs, resolvePath('.'));
  assertDisjointWebArtifactOutputs(outputs);
  assertWebOutputsAvoidStaticDirectories(outputs, targets, resolvePath);
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
  const value = readHtmlAttribute(tag, 'rel');
  return value?.split(/\s+/u).some((token) => token.toLowerCase() === 'manifest') ?? false;
}

function indexHtmlLinksManifest(indexFile: string): boolean {
  return manifestLinkTags(readFileSync(indexFile, 'utf8')).length > 0;
}

function indexHtmlLinksExistingManifest(
  indexFile: string,
  manifests: readonly string[],
): boolean {
  return manifestLinkTags(readFileSync(indexFile, 'utf8')).some((tag) => {
    const href = readHtmlAttribute(tag, 'href');
    if (href === undefined) {
      return false;
    }

    const linkedManifestName = rootManifestNameFromHref(href);
    return linkedManifestName !== undefined
      && manifests.some((manifest) => basename(manifest) === linkedManifestName);
  });
}

function rootManifestNameFromHref(href: string): string | undefined {
  const pathEnd = href.search(/[?#]/u);
  const path = (pathEnd < 0 ? href : href.slice(0, pathEnd)).trim();
  const rootRelativePath = path.startsWith('./')
    ? path.slice(2)
    : path.startsWith('/')
      ? path.slice(1)
      : path;

  return (
    rootRelativePath.length > 0
    && !rootRelativePath.includes('/')
    && !rootRelativePath.includes('\\')
    && installableManifestNames.has(rootRelativePath.toLowerCase())
  )
    ? rootRelativePath
    : undefined;
}

function readHtmlAttribute(tag: string, expectedName: string): string | undefined {
  let index = tag.startsWith('<') ? 1 : 0;

  while (index < tag.length && !/[\s/>]/u.test(tag[index] ?? '')) {
    index += 1;
  }

  while (index < tag.length) {
    while (/\s/u.test(tag[index] ?? '')) {
      index += 1;
    }

    if (index >= tag.length || tag[index] === '>' || tag[index] === '/') {
      return undefined;
    }

    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/u.test(tag[index] ?? '')) {
      index += 1;
    }

    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/u.test(tag[index] ?? '')) {
      index += 1;
    }

    let value = '';
    if (tag[index] === '=') {
      index += 1;
      while (/\s/u.test(tag[index] ?? '')) {
        index += 1;
      }

      const quote = tag[index] === '"' || tag[index] === "'" ? tag[index] : undefined;
      if (quote !== undefined) {
        index += 1;
        const valueStart = index;
        while (index < tag.length && tag[index] !== quote) {
          index += 1;
        }
        value = tag.slice(valueStart, index);
        if (tag[index] === quote) {
          index += 1;
        }
      } else {
        const valueStart = index;
        while (index < tag.length && !/[\s>]/u.test(tag[index] ?? '')) {
          index += 1;
        }
        value = tag.slice(valueStart, index);
      }
    }

    if (name === expectedName) {
      return value;
    }
  }

  return undefined;
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

function isFaviconLinkTag(tag: string, href: string): boolean {
  const rel = readHtmlAttribute(tag, 'rel');

  return rel !== undefined
    && rel.split(/\s+/u).some((token) => token.toLowerCase() === 'icon')
    && readHtmlAttribute(tag, 'href') === href;
}

function insertHtmlHeadTag(html: string, tag: string): string {
  const scan = scanHtmlHead(html);

  if (scan.closingTagStart !== undefined) {
    return html.slice(0, scan.closingTagStart) + `  ${tag}\n` + html.slice(scan.closingTagStart);
  }

  if (scan.headOpeningTagEnd !== undefined) {
    return html.slice(0, scan.headOpeningTagEnd)
      + `\n  ${tag}`
      + html.slice(scan.headOpeningTagEnd);
  }

  const head = `<head>\n  ${tag}\n</head>`;
  if (scan.htmlOpeningTagEnd !== undefined) {
    return html.slice(0, scan.htmlOpeningTagEnd)
      + `\n${head}`
      + html.slice(scan.htmlOpeningTagEnd);
  }

  const doctypeEnd = /^\s*<!doctype[^>]*>/iu.exec(html)?.[0].length ?? 0;
  return html.slice(0, doctypeEnd) + `\n${head}\n` + html.slice(doctypeEnd);
}

function scanHtmlHead(html: string): HtmlHeadScan {
  const lowercaseHtml = html.toLowerCase();
  const linkTags: HtmlTagRange[] = [];
  let closingTagStart: number | undefined;
  let headOpeningTagEnd: number | undefined;
  let htmlOpeningTagEnd: number | undefined;
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
      headOpeningTagEnd = tagEnd + 1;
      continue;
    }

    if (name === 'html' && htmlOpeningTagEnd === undefined) {
      htmlOpeningTagEnd = tagEnd + 1;
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
    ...(headOpeningTagEnd === undefined ? {} : { headOpeningTagEnd }),
    ...(htmlOpeningTagEnd === undefined ? {} : { htmlOpeningTagEnd }),
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
    { name: 'generated icon cache', path: resolvePath(generatedIconCacheDirectory) },
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

function assertWebOutputsAvoidStaticDirectories(
  outputs: readonly NamedWebArtifactOutput[],
  targets: Readonly<Record<string, PlatformTargetConfig>>,
  resolvePath: (path: string) => string,
): void {
  const staticDirectories = Object.entries(targets).flatMap(([name, target]) => {
    return target.kind === 'web' && target.staticDir !== undefined
      ? [{ name: `${name} staticDir`, path: resolvePath(target.staticDir) }]
      : [];
  });
  const canonicalStaticDirectories = staticDirectories.map((staticDirectory) => ({
    ...staticDirectory,
    canonicalPath: canonicalizeThroughExistingAncestor(staticDirectory.path),
  }));

  for (const output of outputs) {
    const canonicalOutput = canonicalizeWebArtifactOutput(output.path);
    for (const staticDirectory of canonicalStaticDirectories) {
      if (pathsOverlap(canonicalOutput, staticDirectory.canonicalPath)) {
        throw new Error(
          `Web staticDir and output must not overlap across configured web targets: ${output.name} (${output.path}) and ${staticDirectory.name} (${staticDirectory.path}).`,
        );
      }
    }
  }
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

function assertWebOutputsStayWithinRoot(
  outputs: readonly NamedWebArtifactOutput[],
  owningRoot: string,
): void {
  const canonicalRoot = canonicalizeThroughExistingAncestor(owningRoot);

  for (const output of outputs) {
    const canonicalOutput = canonicalizeWebArtifactOutput(output.path);
    if (canonicalOutput === canonicalRoot || !isPathWithin(canonicalRoot, canonicalOutput)) {
      throw new Error(
        `Web artifact output must stay inside its game root: ${output.name} (${output.path}).`,
      );
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
  if (lstatIfPresent(path)?.isSymbolicLink() === true) {
    throw new Error(`Web artifact output must not be a symbolic link: ${path}`);
  }

  return canonicalizeThroughExistingAncestor(path);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
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
