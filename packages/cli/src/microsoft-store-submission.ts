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
import { inflateSync } from 'node:zlib';

import {
  escapeMarkdownInline,
  escapeMarkdownTable,
  formatError,
  relativeOrAbsolute,
} from './evidence-io.js';

export const microsoftStoreSubmissionSchemaVersion = 1 as const;

// Microsoft Store listing and package identity limits documented by Microsoft Learn.
const maximumStoreDescriptionCharacters = 10_000;
const maximumStoreDesktopScreenshots = 10;
const maximumStoreManifestIcons = 32;
const maximumStoreScreenshotBytes = 50 * 1024 * 1024;
const maximumStoreIconBytes = 2 * 1024 * 1024;
const minimumStoreScreenshotLongEdge = 1366;
const minimumStoreScreenshotShortEdge = 768;
const maximumDecodedScreenshotBytes = 256 * 1024 * 1024;
const maximumDecodedStoreIconBytes = 16 * 1024 * 1024;
const reservedPackageStringPrefix = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u;
const pngCrc32Table = createPngCrc32Table();

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
    readonly icons: readonly {
      readonly file: string;
      readonly sha256: string;
      readonly width: number;
      readonly height: number;
    }[];
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
  const manifest = parseManifest(manifestSnapshot.value, artifactRoot);
  const warnings = collectManifestWarnings(manifest, config.productIdentity.reservedName);
  const protectedFiles: { readonly file: string; readonly label: string }[] = [
    { file: configFile, label: 'Microsoft Store submission config' },
    { file: manifestFile, label: 'Microsoft Store web app manifest' },
    ...manifest.icons.map((icon) => ({
      file: icon.file,
      label: 'Microsoft Store web app manifest icon',
    })),
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
      iconCount: manifest.icons.length,
      icons: manifest.icons.map((icon) => ({
        file: relativeOrAbsolute(gameRoot, icon.file),
        sha256: icon.sha256,
        width: icon.width,
        height: icon.height,
      })),
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
    `- Manifest icons: ${evidence.manifest.iconCount}`,
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
  readonly icons: readonly {
    readonly file: string;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
  }[];
}

function parseManifest(input: unknown, artifactRoot: string): ParsedManifest {
  const manifest = requireRecord(input, 'web app manifest');
  const icons = requireArray(manifest.icons, 'web app manifest icons');

  if (icons.length === 0) {
    throw new Error('Web app manifest icons must not be empty.');
  }

  if (icons.length > maximumStoreManifestIcons) {
    throw new Error(
      `Web app manifest icons must contain at most ${maximumStoreManifestIcons} entries.`,
    );
  }

  const purposes = new Set<string>();
  const sizes = new Set<string>();
  const parsedIcons = icons.map((icon, index) => {
    const record = requireRecord(icon, `web app manifest icons[${index}]`);
    const label = `web app manifest icons[${index}]`;
    const src = requireManifestUrl(record.src, `${label}.src`);
    const type = requireNonEmptyString(record.type, `${label}.type`);
    const iconSizes = requireNonEmptyString(record.sizes, `${label}.sizes`);
    const purpose = requireNonEmptyString(record.purpose, `${label}.purpose`);
    const sizeMatch = /^(\d+)x(\d+)$/u.exec(iconSizes);

    if (type !== 'image/png') {
      throw new Error(`${label}.type must be image/png.`);
    }

    if (sizeMatch === null) {
      throw new Error(`${label}.sizes must declare one width and height in pixels.`);
    }

    for (const token of purpose.split(/[\t\n\f\r ]+/u)) {
      if (token.length > 0) {
        purposes.add(token);
      }
    }
    sizes.add(iconSizes);

    const declaredWidth = Number(sizeMatch[1]);
    const declaredHeight = Number(sizeMatch[2]);
    const iconFile = readManifestAssetFile(artifactRoot, src, label);
    const image = readMicrosoftStorePng(iconFile, {
      label,
      maximumBytes: maximumStoreIconBytes,
      maximumDecodedBytes: maximumDecodedStoreIconBytes,
      validateDimensions: (width, height) => {
        if (width !== declaredWidth || height !== declaredHeight) {
          throw new Error(`${label} dimensions must match ${iconSizes}: ${iconFile}`);
        }
      },
    });

    return { file: iconFile, ...image };
  });

  for (const purpose of ['any', 'maskable']) {
    if (!purposes.has(purpose)) {
      throw new Error(`Web app manifest icons must include purpose: ${purpose}.`);
    }
  }

  for (const size of ['192x192', '512x512']) {
    if (!sizes.has(size)) {
      throw new Error(`Web app manifest icons must include size: ${size}.`);
    }
  }

  if (manifest.display !== 'standalone') {
    throw new Error('Web app manifest display must be standalone.');
  }

  return {
    source: manifest,
    id: requireProductionString(manifest.id, 'web app manifest id'),
    name: requireProductionString(manifest.name, 'web app manifest name'),
    shortName: requireProductionString(manifest.short_name, 'web app manifest short_name'),
    startUrl: requireManifestUrl(manifest.start_url, 'web app manifest start_url'),
    scope: requireManifestUrl(manifest.scope, 'web app manifest scope'),
    icons: parsedIcons,
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
    ['background_color', 'splash background color'],
    ['orientation', 'orientation'],
    ['screenshots', 'manifest screenshots'],
    ['categories', 'categories'],
  ] as const) {
    if (manifest.source[field] === undefined) {
      warnings.push(`The web app manifest does not declare the recommended ${label}.`);
    }
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

    if (screenshots.length > maximumStoreDesktopScreenshots) {
      throw new Error(
        `listing.locales.${locale}.screenshots must contain at most ${maximumStoreDesktopScreenshots} files.`,
      );
    }

    const description = requireProductionString(
      listing.description,
      `listing.locales.${locale}.description`,
    );

    if (Array.from(description).length > maximumStoreDescriptionCharacters) {
      throw new Error(
        `listing.locales.${locale}.description must not exceed ${maximumStoreDescriptionCharacters} characters.`,
      );
    }

    return [locale, {
      description,
      screenshots,
    }];
  }));
}

function requireManifestUrl(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);
  const base = new URL('https://mpgd.invalid/');
  const url = new URL(value, base);

  if (
    !value.startsWith('./')
    || url.origin !== base.origin
    || url.pathname.startsWith('//')
    || value !== `.${url.pathname}${url.search}${url.hash}`
  ) {
    throw new Error(`${label} must be an artifact-relative URL beginning with ./`);
  }

  return value;
}

function readManifestAssetFile(artifactRoot: string, src: string, label: string): string {
  const url = new URL(src, 'https://mpgd.invalid/');

  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${label}.src must identify one artifact file without a query or fragment.`);
  }

  let pathname: string;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`${label}.src must use valid URL encoding.`);
  }

  return readCanonicalFileInside(artifactRoot, path.resolve(artifactRoot, `.${pathname}`), label);
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

    requireProductionString(
      unwrapDistinguishedNameValue(attributeValue),
      `${label} ${attribute} value`,
    );
  }

  return value;
}

function unwrapDistinguishedNameValue(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
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

  if (value.length < 3 || value.length > 50 || !/^[A-Za-z0-9.-]+$/u.test(value)) {
    throw new Error(
      `${label} must be a Windows package string of 3 to 50 letters, digits, periods, or hyphens.`,
    );
  }

  if (
    normalized === '.'
    || normalized === '..'
    || reservedPackageStringPrefix.test(normalized)
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
  const exactTemplateToken =
    /^(?:TODO|FIXME|PLACEHOLDER|DUMMY|(?:CHANGE|REPLACE)[-_ ]?ME|LOREM(?:_IPSUM)?)$/iu;
  const templateIdentityField =
    label.startsWith('productIdentity.')
    || label.startsWith('web app manifest')
    || label === 'ageRating.iarcId';

  if (
    exactTemplateToken.test(value)
    || (
      templateIdentityField
      && /contoso|\b(?:change|replace)[-_ ]?me\b|^your[-_ ][A-Za-z0-9_-]+$/iu.test(value)
    )
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
  return readMicrosoftStorePng(file, {
    label: 'Microsoft Store screenshot',
    maximumBytes: maximumStoreScreenshotBytes,
    maximumDecodedBytes: maximumDecodedScreenshotBytes,
    validateDimensions: (width, height) => {
      if (
        width === height
        || Math.max(width, height) < minimumStoreScreenshotLongEdge
        || Math.min(width, height) < minimumStoreScreenshotShortEdge
      ) {
        throw new Error(
          `Microsoft Store desktop screenshot must be landscape or portrait and at least ${minimumStoreScreenshotLongEdge} x ${minimumStoreScreenshotShortEdge}: ${file}`,
        );
      }
    },
  });
}

function readMicrosoftStorePng(
  file: string,
  input: {
    readonly label: string;
    readonly maximumBytes: number;
    readonly maximumDecodedBytes: number;
    readonly validateDimensions: (width: number, height: number) => void;
  },
): {
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
} {
  if (path.extname(file).toLowerCase() !== '.png') {
    throw new Error(`${input.label} must be PNG: ${file}`);
  }

  const descriptor = openSync(file, 'r');

  try {
    const before = fstatSync(descriptor);

    if (before.size > input.maximumBytes) {
      throw new Error(`${input.label} exceeds its maximum file size: ${file}`);
    }

    const header = Buffer.alloc(29);

    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`${input.label} must be a valid PNG: ${file}`);
    }

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    if (
      !header.subarray(0, 8).equals(signature)
      || header.readUInt32BE(8) !== 13
      || header.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new Error(`${input.label} must be a valid PNG: ${file}`);
    }

    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    const bitDepth = header[24] ?? 0;
    const colorType = header[25] ?? 0;
    const compressionMethod = header[26] ?? 0;
    const filterMethod = header[27] ?? 0;
    const interlaceMethod = header[28] ?? 0;

    input.validateDimensions(width, height);

    assertDecodedPng({
      descriptor,
      size: before.size,
      file,
      width,
      height,
      bitDepth,
      colorType,
      compressionMethod,
      filterMethod,
      interlaceMethod,
      label: input.label,
      maximumDecodedBytes: input.maximumDecodedBytes,
    });
    const sha256 = hashOpenFile(descriptor);
    const after = fstatSync(descriptor);

    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${input.label} changed while it was being validated: ${file}`);
    }

    return { width, height, sha256 };
  } finally {
    closeSync(descriptor);
  }
}

function assertDecodedPng(input: {
  readonly descriptor: number;
  readonly size: number;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly compressionMethod: number;
  readonly filterMethod: number;
  readonly interlaceMethod: number;
  readonly label: string;
  readonly maximumDecodedBytes: number;
}): void {
  const channels = pngColorChannels(input.colorType);
  const supportedBitDepths = pngSupportedBitDepths(input.colorType);

  if (
    input.width === 0
    || input.height === 0
    || !supportedBitDepths.includes(input.bitDepth)
    || input.compressionMethod !== 0
    || input.filterMethod !== 0
    || (input.interlaceMethod !== 0 && input.interlaceMethod !== 1)
  ) {
    throw new Error(`${input.label} must be a valid PNG: ${input.file}`);
  }

  const passes = calculatePngPasses(
    input.width,
    input.height,
    channels * input.bitDepth,
    input.interlaceMethod,
    input.file,
    input.label,
  );
  let offset = 8;
  let chunkIndex = 0;
  let foundImageData = false;
  let foundEnd = false;
  let imageDataEnded = false;
  let foundPalette = false;
  const imageData: Buffer[] = [];
  const chunkHeader = Buffer.alloc(8);
  const knownCriticalChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

  while (offset + 12 <= input.size) {
    if (
      readSync(input.descriptor, chunkHeader, 0, chunkHeader.length, offset)
      !== chunkHeader.length
    ) {
      break;
    }

    const dataLength = chunkHeader.readUInt32BE(0);
    const type = chunkHeader.toString('ascii', 4, 8);
    const critical = ((chunkHeader[4] ?? 0) & 0x20) === 0;
    const nextOffset = offset + 12 + dataLength;

    if (
      nextOffset > input.size
      || !/^[A-Za-z]{4}$/u.test(type)
      || (critical && !knownCriticalChunks.has(type))
      || (chunkIndex === 0 && (type !== 'IHDR' || dataLength !== 13))
      || (chunkIndex > 0 && type === 'IHDR')
    ) {
      break;
    }

    const data = Buffer.alloc(dataLength);
    const storedCrc = Buffer.alloc(4);

    if (
      readSync(input.descriptor, data, 0, data.length, offset + 8) !== data.length
      || readSync(input.descriptor, storedCrc, 0, 4, offset + 8 + dataLength) !== 4
      || storedCrc.readUInt32BE(0) !== crc32Png([chunkHeader.subarray(4, 8), data])
    ) {
      break;
    }

    if (type === 'PLTE') {
      if (
        foundPalette
        || foundImageData
        || dataLength === 0
        || dataLength % 3 !== 0
        || dataLength > 768
      ) {
        break;
      }

      foundPalette = true;
    }

    if (type === 'IDAT') {
      if (imageDataEnded) {
        break;
      }

      foundImageData = true;
      imageData.push(data);
    } else if (foundImageData && type !== 'IEND') {
      imageDataEnded = true;
    }

    if (type === 'IEND') {
      foundEnd = dataLength === 0 && nextOffset === input.size;
      break;
    }

    offset = nextOffset;
    chunkIndex += 1;
  }

  if (!foundImageData || !foundEnd || (input.colorType === 3 && !foundPalette)) {
    throw new Error(`${input.label} must be a valid PNG: ${input.file}`);
  }

  const expectedBytes = passes.reduce(
    (total, pass) => total + (pass.rowBytes + 1) * pass.rowCount,
    0,
  );
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > input.maximumDecodedBytes) {
    throw new Error(`${input.label} decoded pixel data is too large: ${input.file}`);
  }

  let decoded: Buffer;

  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedBytes });
  } catch {
    throw new Error(`${input.label} must be a valid PNG: ${input.file}`);
  }

  if (decoded.length !== expectedBytes) {
    throw new Error(`${input.label} must be a valid PNG: ${input.file}`);
  }

  let decodedOffset = 0;

  for (const pass of passes) {
    for (let row = 0; row < pass.rowCount; row += 1) {
      if ((decoded[decodedOffset] ?? 5) > 4) {
        throw new Error(`${input.label} must be a valid PNG: ${input.file}`);
      }

      decodedOffset += pass.rowBytes + 1;
    }
  }
}

function pngColorChannels(colorType: number): number {
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(colorType);

  if (channels === undefined) {
    return 0;
  }

  return channels;
}

function pngSupportedBitDepths(colorType: number): readonly number[] {
  switch (colorType) {
    case 0:
      return [1, 2, 4, 8, 16];
    case 2:
    case 4:
    case 6:
      return [8, 16];
    case 3:
      return [1, 2, 4, 8];
    default:
      return [];
  }
}

function calculatePngPasses(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlaceMethod: number,
  file: string,
  label: string,
): readonly { readonly rowBytes: number; readonly rowCount: number }[] {
  const patterns = interlaceMethod === 0
    ? [[0, 0, 1, 1] as const]
    : [
        [0, 0, 8, 8] as const,
        [4, 0, 8, 8] as const,
        [0, 4, 4, 8] as const,
        [2, 0, 4, 4] as const,
        [0, 2, 2, 4] as const,
        [1, 0, 2, 2] as const,
        [0, 1, 1, 2] as const,
      ];

  return patterns.flatMap(([xStart, yStart, xStep, yStep]) => {
    const passWidth = pngPassLength(width, xStart, xStep);
    const rowCount = pngPassLength(height, yStart, yStep);

    if (passWidth === 0 || rowCount === 0) {
      return [];
    }

    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);

    if (!Number.isSafeInteger(rowBytes) || !Number.isSafeInteger((rowBytes + 1) * rowCount)) {
      throw new Error(`${label} decoded pixel data is too large: ${file}`);
    }

    return [{ rowBytes, rowCount }];
  });
}

function pngPassLength(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function crc32Png(parts: readonly Buffer[]): number {
  let crc = 0xffff_ffff;

  for (const part of parts) {
    for (const byte of part) {
      crc = (crc >>> 8) ^ (pngCrc32Table[(crc ^ byte) & 0xff] ?? 0);
    }
  }

  return (crc ^ 0xffff_ffff) >>> 0;
}

function createPngCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let value = 0; value < table.length; value += 1) {
    let crc = value;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }

    table[value] = crc >>> 0;
  }

  return table;
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
  let metadata: ReturnType<typeof lstatSync> | undefined;

  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (metadata !== undefined) {
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${file}`);
    }

    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file when it already exists: ${file}`);
    }
  }

  let resolved = path.join(parent, path.basename(file));

  if (metadata !== undefined) {
    try {
      resolved = realpathSync(file);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

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
