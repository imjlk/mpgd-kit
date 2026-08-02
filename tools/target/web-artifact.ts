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

const installableManifestNames = new Set(['manifest.json', 'manifest.webmanifest']);
const reservedGeneratedEvidenceNames = new Set([
  'mpgd-effective-target.json',
  'mpgd-icon-manifest.json',
  'mpgd-icon-precache.json',
]);
const linkTagPattern = /<link\b[^>]*>/giu;
const relAttributePattern = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

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
  const sanitized = source.replace(linkTagPattern, (tag) =>
    isManifestLinkTag(tag) ? '' : tag,
  );

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
  const withoutManifestLinks = source.replace(linkTagPattern, (tag) =>
    isManifestLinkTag(tag) ? '' : tag,
  );
  const link = '<link rel="manifest" href="./manifest.webmanifest">';
  const linked = withoutManifestLinks.includes('</head>')
    ? withoutManifestLinks.replace('</head>', `  ${link}\n</head>`)
    : `${link}\n${withoutManifestLinks}`;

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

  const canonicalDestination = canonicalizeThroughExistingAncestor(destination);
  if (
    isPathWithin(canonicalSource, canonicalDestination)
    || isPathWithin(canonicalDestination, canonicalSource)
  ) {
    throw new Error(`Web staticDir and output must not overlap: ${source} and ${destination}`);
  }
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
  return [...readFileSync(indexFile, 'utf8').matchAll(linkTagPattern)]
    .some((match) => isManifestLinkTag(match[0]));
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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
