import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import {
  escapeMarkdownInline,
  escapeMarkdownTable,
  formatError,
  relativeOrAbsolute,
} from './evidence-io.js';

export const microsoftStoreSubmissionSchemaVersion = 1 as const;

export interface MicrosoftStoreSubmissionConfig {
  readonly schemaVersion: 1;
  readonly productIdentity: {
    readonly packageId: string;
    readonly publisherId: string;
    readonly publisherDisplayName: string;
    readonly reservedName: string;
  };
  readonly listing: {
    readonly category: 'Games';
    readonly supportUrl: string;
    readonly personalData: {
      readonly accessedOrTransmitted: boolean;
      readonly privacyPolicyUrl?: string;
    };
    readonly locales: Readonly<Record<string, {
      readonly description: string;
      readonly screenshots: readonly string[];
    }>>;
  };
  readonly ageRating: {
    readonly questionnaireCompleted: true;
    readonly iarcId?: string;
  };
  readonly commerce: {
    readonly mode: 'disabled';
  };
}

export interface MicrosoftStoreSubmissionEvidence {
  readonly schemaVersion: 1;
  readonly target: 'microsoft-store';
  readonly configFile: string;
  readonly artifactRoot: string;
  readonly productIdentity: MicrosoftStoreSubmissionConfig['productIdentity'];
  readonly manifest: {
    readonly file: string;
    readonly sha256: string;
    readonly id: string;
    readonly name: string;
    readonly shortName: string;
    readonly startUrl: string;
    readonly scope: string;
    readonly iconCount: number;
  };
  readonly listing: {
    readonly category: 'Games';
    readonly supportUrl: string;
    readonly personalData: MicrosoftStoreSubmissionConfig['listing']['personalData'];
    readonly locales: Readonly<Record<string, {
      readonly description: string;
      readonly screenshots: readonly {
        readonly file: string;
        readonly sha256: string;
        readonly width: number;
        readonly height: number;
      }[];
    }>>;
  };
  readonly ageRating: MicrosoftStoreSubmissionConfig['ageRating'];
  readonly commerce: MicrosoftStoreSubmissionConfig['commerce'];
  readonly warnings: readonly string[];
}

export interface RunMicrosoftStoreSubmissionPreflightInput {
  readonly gameRoot: string;
  readonly artifactRoot: string;
  readonly configFile: string;
  readonly jsonFile: string;
  readonly markdownFile: string;
}

export function runMicrosoftStoreSubmissionPreflight(
  input: RunMicrosoftStoreSubmissionPreflightInput,
): MicrosoftStoreSubmissionEvidence {
  const gameRoot = readCanonicalDirectory(input.gameRoot, 'game root');
  const artifactRoot = readCanonicalDirectoryInside(
    gameRoot,
    input.artifactRoot,
    'Microsoft Store artifact root',
  );
  const configFile = readCanonicalFileInside(
    gameRoot,
    input.configFile,
    'Microsoft Store submission config',
  );
  const config = parseMicrosoftStoreSubmissionConfig(readJson(configFile, 'submission config'));
  const manifestFile = readCanonicalFileInside(
    artifactRoot,
    path.join(artifactRoot, 'manifest.webmanifest'),
    'Microsoft Store web app manifest',
  );
  const manifestSnapshot = readJsonSnapshot(manifestFile, 'web app manifest', 1024 * 1024);
  const manifest = parseManifest(manifestSnapshot.value);
  const warnings = collectManifestWarnings(manifest, config.productIdentity.reservedName);
  const protectedFiles: { readonly file: string; readonly label: string }[] = [
    { file: configFile, label: 'Microsoft Store submission config' },
    { file: manifestFile, label: 'Microsoft Store web app manifest' },
  ];
  const locales = Object.fromEntries(
    Object.entries(config.listing.locales)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([locale, listing]) => [
        locale,
        {
          description: listing.description,
          screenshots: listing.screenshots.map((file) => {
            const screenshotFile = readCanonicalFileInside(
              gameRoot,
              path.resolve(gameRoot, file),
              `Microsoft Store ${locale} screenshot`,
            );
            protectedFiles.push({
              file: screenshotFile,
              label: `Microsoft Store ${locale} screenshot`,
            });
            const image = readMicrosoftStoreScreenshot(screenshotFile);

            return {
              file: relativeOrAbsolute(gameRoot, screenshotFile),
              sha256: image.sha256,
              width: image.width,
              height: image.height,
            };
          }),
        },
      ]),
  );
  const evidence: MicrosoftStoreSubmissionEvidence = {
    schemaVersion: microsoftStoreSubmissionSchemaVersion,
    target: 'microsoft-store',
    configFile: relativeOrAbsolute(gameRoot, configFile),
    artifactRoot: relativeOrAbsolute(gameRoot, artifactRoot),
    productIdentity: config.productIdentity,
    manifest: {
      file: relativeOrAbsolute(gameRoot, manifestFile),
      sha256: hashBytes(manifestSnapshot.bytes),
      id: manifest.id,
      name: manifest.name,
      shortName: manifest.shortName,
      startUrl: manifest.startUrl,
      scope: manifest.scope,
      iconCount: manifest.iconCount,
    },
    listing: {
      category: config.listing.category,
      supportUrl: config.listing.supportUrl,
      personalData: config.listing.personalData,
      locales,
    },
    ageRating: config.ageRating,
    commerce: config.commerce,
    warnings,
  };

  const jsonFile = resolveOutputFileInside(gameRoot, input.jsonFile, 'submission evidence JSON');
  const markdownFile = resolveOutputFileInside(
    gameRoot,
    input.markdownFile,
    'submission evidence Markdown',
  );
  assertDistinctEvidenceFiles(
    [
      { file: jsonFile, label: 'submission evidence JSON' },
      { file: markdownFile, label: 'submission evidence Markdown' },
    ],
    protectedFiles,
  );
  writeFileSync(jsonFile, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(markdownFile, renderMicrosoftStoreSubmissionMarkdown(evidence));

  return evidence;
}

export function parseMicrosoftStoreSubmissionConfig(
  input: unknown,
): MicrosoftStoreSubmissionConfig {
  const root = requireRecord(input, 'Microsoft Store submission config');

  if (root.schemaVersion !== microsoftStoreSubmissionSchemaVersion) {
    throw new Error('Microsoft Store submission config schemaVersion must be 1.');
  }

  const productIdentity = requireRecord(root.productIdentity, 'productIdentity');
  const listing = requireRecord(root.listing, 'listing');
  const personalData = requireRecord(listing.personalData, 'listing.personalData');
  const ageRating = requireRecord(root.ageRating, 'ageRating');
  const commerce = requireRecord(root.commerce, 'commerce');
  const packageId = requireIdentityToken(productIdentity.packageId, 'productIdentity.packageId');
  const publisherId = requirePublisherDistinguishedName(
    productIdentity.publisherId,
    'productIdentity.publisherId',
  );

  if (listing.category !== 'Games') {
    throw new Error('listing.category must be Games.');
  }

  const accessedOrTransmitted = requireBoolean(
    personalData.accessedOrTransmitted,
    'listing.personalData.accessedOrTransmitted',
  );
  const privacyPolicyUrl = optionalPublicHttpsUrl(
    personalData.privacyPolicyUrl,
    'listing.personalData.privacyPolicyUrl',
  );

  if (accessedOrTransmitted && privacyPolicyUrl === undefined) {
    throw new Error(
      'listing.personalData.privacyPolicyUrl is required when personal data is accessed or transmitted.',
    );
  }

  const locales = parseListings(listing.locales);

  if (ageRating.questionnaireCompleted !== true) {
    throw new Error('ageRating.questionnaireCompleted must be true before submission.');
  }

  if (commerce.mode !== 'disabled') {
    throw new Error(
      'commerce.mode must stay disabled until Microsoft Store commerce is backed by server-side ledger verification.',
    );
  }

  const iarcId = optionalProductionString(ageRating.iarcId, 'ageRating.iarcId');

  return {
    schemaVersion: microsoftStoreSubmissionSchemaVersion,
    productIdentity: {
      packageId,
      publisherId,
      publisherDisplayName: requireProductionString(
        productIdentity.publisherDisplayName,
        'productIdentity.publisherDisplayName',
      ),
      reservedName: requireProductionString(
        productIdentity.reservedName,
        'productIdentity.reservedName',
      ),
    },
    listing: {
      category: 'Games',
      supportUrl: requirePublicHttpsUrl(listing.supportUrl, 'listing.supportUrl'),
      personalData: {
        accessedOrTransmitted,
        ...(privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl }),
      },
      locales,
    },
    ageRating: {
      questionnaireCompleted: true,
      ...(iarcId === undefined ? {} : { iarcId }),
    },
    commerce: { mode: 'disabled' },
  };
}

export function renderMicrosoftStoreSubmissionMarkdown(
  evidence: MicrosoftStoreSubmissionEvidence,
): string {
  const lines = [
    '# Microsoft Store Submission Preflight',
    '',
    `- Target: ${evidence.target}`,
    `- Package ID: ${escapeMarkdownInline(evidence.productIdentity.packageId)}`,
    `- Publisher ID: ${escapeMarkdownInline(evidence.productIdentity.publisherId)}`,
    `- Reserved name: ${escapeMarkdownInline(evidence.productIdentity.reservedName)}`,
    `- Manifest: ${escapeMarkdownInline(evidence.manifest.file)} (${evidence.manifest.sha256})`,
    `- Commerce: ${evidence.commerce.mode}`,
    `- Personal data accessed or transmitted: ${String(evidence.listing.personalData.accessedOrTransmitted)}`,
    `- Privacy policy: ${escapeMarkdownInline(evidence.listing.personalData.privacyPolicyUrl ?? 'Not required')}`,
    '',
    '## Store Listings',
    '',
    '| Locale | Screenshots | Description |',
    '| --- | ---: | --- |',
  ];

  for (const [locale, listing] of Object.entries(evidence.listing.locales)) {
    lines.push(
      `| ${escapeMarkdownTable(locale)} | ${listing.screenshots.length} | ${escapeMarkdownTable(listing.description)} |`,
    );
  }

  lines.push('', '## Warnings', '');

  if (evidence.warnings.length === 0) {
    lines.push('- None.');
  } else {
    lines.push(...evidence.warnings.map((warning) => `- ${escapeMarkdownInline(warning)}`));
  }

  return `${lines.join('\n')}\n`;
}

interface ParsedManifest {
  readonly source: Record<string, unknown>;
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly startUrl: string;
  readonly scope: string;
  readonly iconCount: number;
}

function parseManifest(input: unknown): ParsedManifest {
  const manifest = requireRecord(input, 'web app manifest');
  const icons = requireArray(manifest.icons, 'web app manifest icons');

  if (icons.length === 0) {
    throw new Error('Web app manifest icons must not be empty.');
  }

  for (const [index, icon] of icons.entries()) {
    const record = requireRecord(icon, `web app manifest icons[${index}]`);
    requireNonEmptyString(record.src, `web app manifest icons[${index}].src`);
  }

  return {
    source: manifest,
    id: requireProductionString(manifest.id, 'web app manifest id'),
    name: requireProductionString(manifest.name, 'web app manifest name'),
    shortName: requireProductionString(manifest.short_name, 'web app manifest short_name'),
    startUrl: requireManifestUrl(manifest.start_url, 'web app manifest start_url'),
    scope: requireManifestUrl(manifest.scope, 'web app manifest scope'),
    iconCount: icons.length,
  };
}

function collectManifestWarnings(
  manifest: ParsedManifest,
  reservedName: string,
): readonly string[] {
  const warnings: string[] = [];

  if (manifest.name !== reservedName) {
    warnings.push('The web app manifest name differs from the Partner Center reserved name.');
  }

  for (const [field, label] of [
    ['description', 'description'],
    ['display', 'display mode'],
    ['background_color', 'splash background color'],
    ['orientation', 'orientation'],
    ['screenshots', 'manifest screenshots'],
    ['categories', 'categories'],
  ] as const) {
    if (manifest.source[field] === undefined) {
      warnings.push(`The web app manifest does not declare the recommended ${label}.`);
    }
  }

  const icons = manifest.source.icons;

  if (!Array.isArray(icons)) {
    warnings.push('The web app manifest does not declare valid icons.');
    return warnings;
  }

  const hasMaskableIcon = icons.some((icon) => {
    const purpose = isRecord(icon) ? icon.purpose : undefined;
    return typeof purpose === 'string' && purpose.split(/\s+/u).includes('maskable');
  });

  if (!hasMaskableIcon) {
    warnings.push('The web app manifest does not declare a recommended maskable icon.');
  }

  return warnings;
}

function parseListings(input: unknown): MicrosoftStoreSubmissionConfig['listing']['locales'] {
  const locales = requireRecord(input, 'listing.locales');
  const entries = Object.entries(locales);

  if (entries.length === 0) {
    throw new Error('listing.locales must contain at least one locale.');
  }

  return Object.fromEntries(entries.map(([locale, inputListing]) => {
    assertLocale(locale);
    const listing = requireRecord(inputListing, `listing.locales.${locale}`);
    const screenshots = requireArray(
      listing.screenshots,
      `listing.locales.${locale}.screenshots`,
    ).map((file, index) => requireRelativePath(
      file,
      `listing.locales.${locale}.screenshots[${index}]`,
    ));

    if (screenshots.length === 0) {
      throw new Error(`listing.locales.${locale}.screenshots must not be empty.`);
    }

    if (screenshots.length > 10) {
      throw new Error(`listing.locales.${locale}.screenshots must contain at most 10 files.`);
    }

    const description = requireProductionString(
      listing.description,
      `listing.locales.${locale}.description`,
    );

    if (Array.from(description).length > 10_000) {
      throw new Error(`listing.locales.${locale}.description must not exceed 10000 characters.`);
    }

    return [locale, {
      description,
      screenshots,
    }];
  }));
}

function requireManifestUrl(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);
  const url = new URL(value, 'https://mpgd.invalid/');

  if (url.protocol !== 'https:') {
    throw new Error(`${label} must resolve to HTTPS.`);
  }

  return value;
}

function requirePublicHttpsUrl(input: unknown, label: string): string {
  const value = requireProductionString(input, label);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid public HTTPS URL.`);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const unbracketedHostname = hostname.replace(/^\[|\]$/gu, '');

  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === 'example.com'
    || hostname.endsWith('.example.com')
    || hostname === 'example.net'
    || hostname.endsWith('.example.net')
    || hostname === 'example.org'
    || hostname.endsWith('.example.org')
    || ['invalid', 'test', 'example'].some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
    || isIP(unbracketedHostname) !== 0
  ) {
    throw new Error(`${label} must be a valid public HTTPS URL.`);
  }

  return url.href;
}

function optionalPublicHttpsUrl(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : requirePublicHttpsUrl(input, label);
}

function requirePublisherDistinguishedName(input: unknown, label: string): string {
  const value = requireProductionString(input, label);
  const components = splitDistinguishedName(value, label);

  for (const [index, component] of components.entries()) {
    const separator = findDistinguishedNameEquals(component);

    if (separator <= 0 || separator === component.length - 1) {
      throw new Error(`${label} must be a complete X.509 distinguished name.`);
    }

    const attribute = component.slice(0, separator).trim();
    const attributeValue = component.slice(separator + 1).trim();

    if (
      !/^(?:[A-Za-z][A-Za-z0-9.-]*|[0-9]+(?:\.[0-9]+)+)$/u.test(attribute)
      || attributeValue.length === 0
      || /[\u0000-\u001f\u007f]/u.test(attributeValue)
      || (index === 0 && attribute.toUpperCase() !== 'CN')
    ) {
      throw new Error(`${label} must be a complete X.509 distinguished name beginning with CN=.`);
    }
  }

  return value;
}

function splitDistinguishedName(value: string, label: string): readonly string[] {
  const components: string[] = [];
  let current = '';
  let escaped = false;
  let quoted = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      current += character;
      escaped = true;
    } else if (character === '"') {
      current += character;
      quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '+')) {
      components.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }

  components.push(current.trim());

  if (escaped || quoted || components.some((component) => component.length === 0)) {
    throw new Error(`${label} must be a complete X.509 distinguished name.`);
  }

  return components;
}

function findDistinguishedNameEquals(component: string): number {
  let escaped = false;
  let quoted = false;

  for (let index = 0; index < component.length; index += 1) {
    const character = component[index];

    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === '=') {
      return index;
    }
  }

  return -1;
}

function requireIdentityToken(input: unknown, label: string): string {
  const value = requireProductionString(input, label);
  const normalized = value.toLowerCase();
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u;

  if (value.length < 3 || value.length > 50 || !/^[A-Za-z0-9.-]+$/u.test(value)) {
    throw new Error(
      `${label} must be a Windows package string of 3 to 50 letters, digits, periods, or hyphens.`,
    );
  }

  if (
    normalized === '.'
    || normalized === '..'
    || reserved.test(normalized)
    || normalized.startsWith('xn--')
    || normalized.endsWith('.')
    || normalized.includes('.xn--')
  ) {
    throw new Error(`${label} violates Windows package string restrictions.`);
  }

  return value;
}

function requireProductionString(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);

  if (
    /contoso|change[-_ ]?me|replace[-_ ]?me|your[-_ ]|\b(?:todo|fixme|placeholder|dummy|sample|lorem)\b/iu
      .test(value)
  ) {
    throw new Error(`${label} still contains placeholder content.`);
  }

  return value;
}

function optionalProductionString(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : requireProductionString(input, label);
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }

  return input;
}

function requireRelativePath(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);

  if (path.isAbsolute(value) || value.split(/[\\/]/u).includes('..')) {
    throw new Error(`${label} must be a game-relative path without parent traversal.`);
  }

  return value;
}

function requireBoolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }

  return input;
}

function requireArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array.`);
  }

  return input;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${label} must be an object.`);
  }

  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function assertLocale(locale: string): void {
  try {
    const normalized = new Intl.Locale(locale).toString();

    if (normalized !== locale) {
      throw new Error('not normalized');
    }
  } catch {
    throw new Error(`listing locale must be a normalized BCP 47 tag: ${locale}`);
  }
}

function readMicrosoftStoreScreenshot(file: string): {
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
} {
  if (path.extname(file).toLowerCase() !== '.png') {
    throw new Error(`Microsoft Store screenshot must be PNG: ${file}`);
  }

  const maximumScreenshotBytes = 50 * 1024 * 1024;
  const descriptor = openSync(file, 'r');

  try {
    const before = fstatSync(descriptor);

    if (before.size > maximumScreenshotBytes) {
      throw new Error(`Microsoft Store screenshot must not exceed 50 MB: ${file}`);
    }

    const header = Buffer.alloc(24);

    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`Microsoft Store screenshot must be a valid PNG: ${file}`);
    }

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    if (
      !header.subarray(0, 8).equals(signature)
      || header.readUInt32BE(8) !== 13
      || header.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new Error(`Microsoft Store screenshot must be a valid PNG: ${file}`);
    }

    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);

    if (Math.max(width, height) < 1366 || Math.min(width, height) < 768) {
      throw new Error(
        `Microsoft Store desktop screenshot must be at least 1366 x 768 in landscape or portrait orientation: ${file}`,
      );
    }

    assertPngChunkStructure(descriptor, before.size, file);
    const sha256 = hashOpenFile(descriptor);
    const after = fstatSync(descriptor);

    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Microsoft Store screenshot changed while it was being validated: ${file}`);
    }

    return { width, height, sha256 };
  } finally {
    closeSync(descriptor);
  }
}

function assertPngChunkStructure(descriptor: number, size: number, file: string): void {
  let offset = 8;
  let chunkIndex = 0;
  let foundImageData = false;
  let foundEnd = false;
  const chunkHeader = Buffer.alloc(8);

  while (offset + 12 <= size) {
    if (readSync(descriptor, chunkHeader, 0, chunkHeader.length, offset) !== chunkHeader.length) {
      break;
    }

    const dataLength = chunkHeader.readUInt32BE(0);
    const type = chunkHeader.toString('ascii', 4, 8);
    const nextOffset = offset + 12 + dataLength;

    if (nextOffset > size || (chunkIndex === 0 && (type !== 'IHDR' || dataLength !== 13))) {
      break;
    }

    if (type === 'IDAT') {
      foundImageData = true;
    }

    if (type === 'IEND') {
      foundEnd = dataLength === 0 && nextOffset === size;
      break;
    }

    offset = nextOffset;
    chunkIndex += 1;
  }

  if (!foundImageData || !foundEnd) {
    throw new Error(`Microsoft Store screenshot must be a valid PNG: ${file}`);
  }
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to read ${label} ${file}: ${formatError(error)}`);
  }
}

function readJsonSnapshot(
  file: string,
  label: string,
  maximumBytes: number,
): { readonly bytes: Buffer; readonly value: unknown } {
  let descriptor: number | undefined;

  try {
    descriptor = openSync(file, 'r');
    const before = fstatSync(descriptor);

    if (before.size > maximumBytes) {
      throw new Error(`exceeds ${maximumBytes} bytes`);
    }

    const bytes = Buffer.alloc(before.size);
    let offset = 0;

    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, null);

      if (bytesRead === 0) {
        throw new Error('changed while it was being read');
      }

      offset += bytesRead;
    }

    const after = fstatSync(descriptor);

    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('changed while it was being read');
    }

    return { bytes, value: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch (error) {
    throw new Error(`Failed to read ${label} ${file}: ${formatError(error)}`);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function hashOpenFile(descriptor: number): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  while (true) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

    if (bytesRead === 0) {
      return hash.digest('hex');
    }

    hash.update(buffer.subarray(0, bytesRead));
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readCanonicalDirectory(input: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(input);
  } catch (error) {
    throw new Error(`${label} must exist: ${input} (${formatError(error)})`);
  }

  if (!lstatSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a directory: ${canonical}`);
  }

  return canonical;
}

function readCanonicalDirectoryInside(root: string, input: string, label: string): string {
  const canonical = readCanonicalDirectory(input, label);
  assertInside(root, canonical, label);
  return canonical;
}

function readCanonicalFileInside(root: string, input: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(input);
  } catch (error) {
    throw new Error(`${label} must exist: ${input} (${formatError(error)})`);
  }

  assertInside(root, canonical, label);

  if (!lstatSync(canonical).isFile()) {
    throw new Error(`${label} must be a regular file: ${canonical}`);
  }

  return canonical;
}

function resolveOutputFileInside(root: string, file: string, label: string): string {
  const parent = readCanonicalDirectory(path.dirname(file), `${label} directory`);
  assertInside(root, parent, label);

  if (existsSync(file)) {
    const metadata = lstatSync(file);

    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${file}`);
    }

    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file when it already exists: ${file}`);
    }
  }

  const resolved = existsSync(file) ? realpathSync(file) : path.join(parent, path.basename(file));
  assertInside(root, resolved, label);
  return resolved;
}

function assertDistinctEvidenceFiles(
  outputs: readonly { readonly file: string; readonly label: string }[],
  protectedFiles: readonly { readonly file: string; readonly label: string }[],
): void {
  for (const [index, output] of outputs.entries()) {
    for (const candidate of [...outputs.slice(index + 1), ...protectedFiles]) {
      if (sameFile(output.file, candidate.file)) {
        throw new Error(`${output.label} must not alias ${candidate.label}: ${output.file}`);
      }
    }
  }
}

function sameFile(left: string, right: string): boolean {
  if (path.relative(left, right).length === 0) {
    return true;
  }

  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }

  const leftMetadata = statSync(left);
  const rightMetadata = statSync(right);
  return leftMetadata.dev === rightMetadata.dev && leftMetadata.ino === rightMetadata.ino;
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the game root.`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
