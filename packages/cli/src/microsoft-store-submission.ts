import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
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
    readonly privacyPolicyUrl?: string;
    readonly locales: Readonly<Record<string, {
      readonly description: string;
      readonly screenshots: readonly {
        readonly file: string;
        readonly sha256: string;
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
  const manifest = parseManifest(readJson(manifestFile, 'web app manifest'));
  const warnings = collectManifestWarnings(manifest, config.productIdentity.reservedName);
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
            assertScreenshotExtension(screenshotFile);

            return {
              file: relativeOrAbsolute(gameRoot, screenshotFile),
              sha256: hashFile(screenshotFile, `Microsoft Store ${locale} screenshot`),
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
      sha256: hashFile(manifestFile, 'Microsoft Store web app manifest'),
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
      ...(config.listing.personalData.privacyPolicyUrl === undefined
        ? {}
        : { privacyPolicyUrl: config.listing.personalData.privacyPolicyUrl }),
      locales,
    },
    ageRating: config.ageRating,
    commerce: config.commerce,
    warnings,
  };

  assertOutputFileInside(gameRoot, input.jsonFile, 'submission evidence JSON');
  assertOutputFileInside(gameRoot, input.markdownFile, 'submission evidence Markdown');
  writeFileSync(input.jsonFile, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(input.markdownFile, renderMicrosoftStoreSubmissionMarkdown(evidence));

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
  const publisherId = requireProductionString(
    productIdentity.publisherId,
    'productIdentity.publisherId',
  );

  if (!publisherId.startsWith('CN=')) {
    throw new Error('productIdentity.publisherId must start with CN=.');
  }

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

    return [locale, {
      description: requireProductionString(
        listing.description,
        `listing.locales.${locale}.description`,
      ),
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
    || isIP(unbracketedHostname) !== 0
  ) {
    throw new Error(`${label} must be a valid public HTTPS URL.`);
  }

  return url.href;
}

function optionalPublicHttpsUrl(input: unknown, label: string): string | undefined {
  return input === undefined ? undefined : requirePublicHttpsUrl(input, label);
}

function requireIdentityToken(input: unknown, label: string): string {
  const value = requireProductionString(input, label);

  if (!/^[A-Za-z0-9.-]+$/u.test(value)) {
    throw new Error(`${label} must contain only letters, digits, periods, and hyphens.`);
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

function assertScreenshotExtension(file: string): void {
  if (!['.jpeg', '.jpg', '.png'].includes(path.extname(file).toLowerCase())) {
    throw new Error(`Microsoft Store screenshot must be PNG or JPEG: ${file}`);
  }
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to read ${label} ${file}: ${formatError(error)}`);
  }
}

function hashFile(file: string, label: string): string {
  try {
    const descriptor = openSync(file, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);

    try {
      while (true) {
        const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

        if (bytesRead === 0) {
          break;
        }

        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      closeSync(descriptor);
    }

    return hash.digest('hex');
  } catch (error) {
    throw new Error(`Failed to hash ${label} ${file}: ${formatError(error)}`);
  }
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

function assertOutputFileInside(root: string, file: string, label: string): void {
  const parent = readCanonicalDirectory(path.dirname(file), `${label} directory`);
  assertInside(root, parent, label);

  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${file}`);
  }
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
