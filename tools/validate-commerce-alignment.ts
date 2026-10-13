import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { bridgeCommerceV2Methods } from '@mpgd/bridge';
import type { PlatformProviderAvailability } from '@mpgd/platform';
import {
  assertCommerceCapabilities,
  commerceBridgeMethods,
  commerceProtocolVersion,
  createUnsupportedCommerceCapabilities,
  type CommerceCapabilities,
} from '@mpgd/platform/commerce';
import {
  assertCommerceConformanceVector,
  commerceConformanceVectorNameOf,
} from '@mpgd/platform/commerce-vectors';
import { createCreditCommerceCapabilities } from '@mpgd/platform/commerce-wallet';

import { createAitCommerceCapabilities } from '../adapters/ait/src/commerce-provider';
import { createMicrosoftStoreCommerceCapabilities } from '../adapters/browser/src/microsoft-store-commerce-provider';
import { createOnePlayCommerceCapabilities } from '../adapters/browser/src/oneplay-commerce';
import { createDevvitCommerceCapabilities } from '../adapters/devvit/src/commerce-contract';
import { createVerse8CommerceCapabilities } from '../adapters/verse8/src/commerce-contract';
import { createPlayBillingCommerceCapabilities } from '../native-plugins/capacitor-play-billing/src/commerce-profile';
import { createStoreKitCommerceCapabilities } from '../native-plugins/capacitor-storekit/src/commerce-profile';
import {
  checkBridgeMethodLists,
  compareCapabilityBlockToRfcRow,
  parseRfcCapabilityProfiles,
  type SourceText,
} from './commerce/alignment-checks';
import {
  commerceSchemaDirectory,
  commerceSchemaRegenerateCommand,
  renderCommerceSchemaFiles,
} from './commerce/generate-commerce-schemas';
import { isCliEntrypoint, readJsonFile } from './io';

export const commerceVectorDirectory = 'docs/specs/commerce/vectors';
export const commerceRfcPath = 'docs/specs/commerce/commerce-v2-rfc.md';

export interface CommerceAlignmentReport {
  readonly protocolVersion: string;
  readonly vectors: readonly string[];
  readonly schemaFiles: readonly string[];
  readonly bridgeMethods: readonly string[];
  readonly providerProfiles: readonly string[];
  readonly scannedSources: number;
}

const availabilityStates: readonly PlatformProviderAvailability[] = [
  'unsupported',
  'configuration-required',
  'action-required',
  'temporarily-unavailable',
  'available',
];

/**
 * Hard gate: throws, never warns, when the pieces of the commerce contract
 * drift apart. It checks that
 *
 * - the protocol constant, every conformance vector, and the committed JSON
 *   Schemas agree (the schemas are regenerated from the contract types and
 *   compared byte for byte);
 * - the bridge method lists agree: the platform list, the bridge list and
 *   union, the RFC, the published bridge schemas, and every transport source
 *   that serves `commerce.v2.*` (a file naming some of the six names all of
 *   them), and no removed v1 `commerce.*` method is named anywhere in source;
 * - every reference provider's declared capability block is valid under the
 *   contract (`assertCommerceCapabilities`), keeps its non-availability fields
 *   constant across readiness states, and equals its RFC profile row.
 *
 * It reads source only; no package build runs.
 */
export function validateCommerceAlignment(input: {
  readonly vectorDirectory?: string;
  readonly schemaDirectory?: string;
  readonly rfcPath?: string;
  readonly sourceRoot?: string;
} = {}): CommerceAlignmentReport {
  const vectorDirectory = input.vectorDirectory ?? commerceVectorDirectory;
  const schemaDirectory = input.schemaDirectory ?? commerceSchemaDirectory;
  const rfcPath = input.rfcPath ?? commerceRfcPath;
  const sourceRoot = input.sourceRoot ?? '.';
  const failures: string[] = [];

  const vectorFiles = readdirSync(vectorDirectory).filter((file) => file.endsWith('.json')).sort();
  if (vectorFiles.length === 0) {
    failures.push(`No conformance vectors found in ${vectorDirectory}.`);
  }
  const vectors: string[] = [];
  for (const file of vectorFiles) {
    const path = join(vectorDirectory, file);
    try {
      const vector = assertCommerceConformanceVector(readJsonFile(path));
      const expectedName = commerceConformanceVectorNameOf(file);
      if (vector.vector !== expectedName) {
        failures.push(
          `${path}: vector name ${vector.vector} must equal the file name ${expectedName}.`,
        );
      }
      if (vector.protocol !== commerceProtocolVersion) {
        failures.push(
          `${path}: protocol ${vector.protocol} must equal commerceProtocolVersion `
            + `${commerceProtocolVersion}.`,
        );
      }
      vectors.push(vector.vector);
    } catch (error) {
      failures.push(`${path}: ${errorMessage(error)}`);
    }
  }

  const rendered = renderCommerceSchemaFiles();
  const changed: string[] = [];
  for (const file of rendered) {
    const path = join(schemaDirectory, file.fileName);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== file.content) {
      changed.push(file.fileName);
      continue;
    }
    const document = readJsonFile(path) as Readonly<Record<string, unknown>>;
    const version = file.fileName === 'index.json'
      ? document.protocolVersion
      : document['x-mpgd-protocol-version'];
    if (version !== commerceProtocolVersion) {
      failures.push(
        `${path}: schema protocol version ${String(version)} must equal ${commerceProtocolVersion}.`,
      );
    }
  }
  const expectedFiles = new Set(rendered.map((file) => file.fileName));
  const stale = existsSync(schemaDirectory)
    ? readdirSync(schemaDirectory).filter(
        (file) => file.endsWith('.json') && !expectedFiles.has(file),
      )
    : [];
  if (changed.length > 0 || stale.length > 0) {
    failures.push(
      `Commerce schemas in ${schemaDirectory} are out of date `
        + `(changed: ${changed.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}). `
        + `Run ${commerceSchemaRegenerateCommand} and commit the result.`,
    );
  }

  const rfc = readFileSync(rfcPath, 'utf8');
  const sources = collectTransportSources(sourceRoot);
  const schemaTitles = existsSync(join(schemaDirectory, 'index.json'))
    ? ((readJsonFile(join(schemaDirectory, 'index.json')) as {
        readonly schemas?: readonly { readonly title?: string }[];
      }).schemas ?? []).flatMap((entry) => (entry.title === undefined ? [] : [entry.title]))
    : [];
  failures.push(...checkBridgeMethodLists({
    platformMethods: commerceBridgeMethods,
    bridgeMethods: bridgeCommerceV2Methods,
    bridgeIndexSource: {
      path: 'packages/bridge/src/index.ts',
      text: readFileSync(join(sourceRoot, 'packages/bridge/src/index.ts'), 'utf8'),
    },
    rfcBridgeSection: { path: rfcPath, text: rfcSection(rfc, 'Bridge and versioning') },
    schemaTitles,
    sources,
  }));

  const profiles = checkProviderCapabilityBlocks(rfc);
  failures.push(...profiles.failures);

  if (failures.length > 0) {
    throw new Error(`Commerce v2 alignment failed:\n- ${failures.join('\n- ')}`);
  }
  return {
    protocolVersion: commerceProtocolVersion,
    vectors,
    schemaFiles: rendered.map((file) => file.fileName),
    bridgeMethods: [...commerceBridgeMethods],
    providerProfiles: profiles.stores,
    scannedSources: sources.length,
  };
}

interface ReferenceProviderBlock {
  /** The store id of the RFC profile row. */
  readonly store: string;
  readonly label: string;
  /** The block for a readiness state. Fresh on every call. */
  readonly create: (availability: PlatformProviderAvailability) => CommerceCapabilities;
}

/** Every reference provider whose declared block the RFC profile table fixes. */
export function referenceProviderBlocks(): readonly ReferenceProviderBlock[] {
  return [
    {
      store: 'google-play',
      label: '@mpgd/capacitor-play-billing createPlayBillingCommerceCapabilities',
      create: createPlayBillingCommerceCapabilities,
    },
    {
      store: 'app-store',
      label: '@mpgd/capacitor-storekit createStoreKitCommerceCapabilities',
      create: createStoreKitCommerceCapabilities,
    },
    {
      store: 'microsoft-store',
      label: '@mpgd/adapter-browser createMicrosoftStoreCommerceCapabilities',
      create: createMicrosoftStoreCommerceCapabilities,
    },
    {
      store: 'apps-in-toss',
      label: '@mpgd/adapter-ait createAitCommerceCapabilities',
      create: createAitCommerceCapabilities,
    },
    {
      store: 'devvit',
      label: '@mpgd/adapter-devvit createDevvitCommerceCapabilities',
      create: createDevvitCommerceCapabilities,
    },
    {
      store: 'verse8',
      label: '@mpgd/adapter-verse8 createVerse8CommerceCapabilities',
      create: createVerse8CommerceCapabilities,
    },
    {
      store: 'oneplay',
      label: '@mpgd/adapter-browser createOnePlayCommerceCapabilities',
      create: (availability) =>
        createOnePlayCommerceCapabilities({
          availability,
          consumable: true,
          durable: true,
          catalogProducts: true,
        }),
    },
    {
      store: 'wallet',
      label: '@mpgd/platform/commerce-wallet createCreditCommerceCapabilities (host authority)',
      create: (availability) =>
        createCreditCommerceCapabilities('host', { availability }, { subscriptions: true }),
    },
  ];
}

function checkProviderCapabilityBlocks(rfc: string): {
  readonly stores: readonly string[];
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  const parsed = parseRfcCapabilityProfiles(rfc);
  failures.push(...parsed.failures);
  const rows = new Map(parsed.rows.map((row) => [row.store, row]));
  const checked: string[] = [];
  const providers = referenceProviderBlocks();
  for (const provider of providers) {
    const row = rows.get(provider.store);
    if (row === undefined) {
      failures.push(`${commerceRfcPath} has no capability profile row for ${provider.store}.`);
      continue;
    }
    checked.push(provider.store);
    let reference: CommerceCapabilities | undefined;
    for (const availability of availabilityStates) {
      let block: CommerceCapabilities;
      try {
        block = provider.create(availability);
        assertCommerceCapabilities(block);
      } catch (error) {
        failures.push(
          `${provider.label}(${availability}) is not a valid CommerceCapabilities block: `
            + `${errorMessage(error)}`,
        );
        continue;
      }
      if (block.availability !== availability) {
        failures.push(
          `${provider.label}(${availability}) reports availability ${block.availability}.`,
        );
      }
      if (reference === undefined) {
        reference = block;
        failures.push(...compareCapabilityBlockToRfcRow(provider.label, row, block));
      } else if (!sameExceptAvailability(reference, block)) {
        failures.push(
          `${provider.label}: capabilities other than availability change with the readiness `
            + `state (${availability}).`,
        );
      }
    }
  }
  for (const row of rows.values()) {
    if (!providers.some((provider) => provider.store === row.store)) {
      failures.push(
        `${commerceRfcPath}: the profile row for ${row.store} has no reference provider block `
          + 'checked by the alignment validator.',
      );
    }
  }
  const unsupported = createUnsupportedCommerceCapabilities();
  try {
    assertCommerceCapabilities(unsupported);
  } catch (error) {
    failures.push(`createUnsupportedCommerceCapabilities is not valid: ${errorMessage(error)}`);
  }
  if (unsupported.availability !== 'unsupported') {
    failures.push('createUnsupportedCommerceCapabilities must report availability unsupported.');
  }
  return { stores: checked, failures };
}

function sameExceptAvailability(left: CommerceCapabilities, right: CommerceCapabilities): boolean {
  const strip = (block: CommerceCapabilities): string =>
    JSON.stringify({ ...block, availability: undefined });
  return strip(left) === strip(right);
}

/** The text of one `## ` RFC section. */
function rfcSection(markdown: string, title: string): string {
  const start = markdown.indexOf(`\n## ${title}`);
  if (start < 0) {
    return '';
  }
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next < 0 ? undefined : next);
}

const transportRoots = ['packages', 'adapters', 'native-plugins', 'apps', 'examples'] as const;
const transportExtensions = /\.(?:ts|tsx|mjs|js|java|kt|swift)$/u;
const testPath = /(?:\.(?:test|spec|conformance)\.[a-z]+$|\/tests?\/|\/__tests__\/)/u;

/**
 * Non-test sources that can name bridge methods: packages, adapters, native
 * plugins, apps, and starters (the CLI template lives under packages/cli).
 * The list comes from the repository index (tracked files plus untracked
 * files that are not ignored), so build output and installed dependencies are
 * never scanned and a new file counts before it is added.
 */
export function collectTransportSources(root: string): SourceText[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...transportRoots],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const found: SourceText[] = [];
  for (const path of new Set(listed.split('\0'))) {
    if (
      path === ''
      || !transportExtensions.test(path)
      || testPath.test(path)
      || !existsSync(join(root, path))
    ) {
      continue;
    }
    const full = join(root, path);
    if (statSync(full).size > 2_000_000) {
      continue;
    }
    found.push({ path, text: readFileSync(full, 'utf8') });
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isCliEntrypoint(import.meta.url)) {
  const report = validateCommerceAlignment();
  console.info(
    `Commerce v2 alignment ${report.protocolVersion}: ${report.vectors.length} vectors, `
      + `${report.schemaFiles.length} schema files, ${report.bridgeMethods.length} bridge methods, `
      + `${report.providerProfiles.length} provider profiles, ${report.scannedSources} sources`,
  );
}
