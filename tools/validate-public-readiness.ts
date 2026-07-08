import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverPublishablePackages } from './package/workspace';
import { validateEffectiveTargetConfigMatrix } from './target/effective-config';
import { validateAdPlacementsFile } from './validate-ad-placements';
import { validateProductCatalogFile } from './validate-product-catalog';
import { validateTargetConfigMatrixFile } from './validate-target-config';

interface PackageMetadata {
  readonly name?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
    readonly directory?: string;
  };
  readonly bugs?: {
    readonly url?: string;
  };
  readonly homepage?: string;
  readonly keywords?: readonly string[];
  readonly publishConfig?: {
    readonly access?: string;
  };
}

const requiredFiles = [
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'docs/PUBLIC_RELEASE_CHECKLIST.md',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
];

const requiredIgnorePatterns = [
  'node_modules/',
  'dist/',
  'artifacts/',
  'release-output/',
  'output/',
  '.turbo/',
  '.wrangler/',
  '.env',
  '.env.*',
  '.devvit/',
  '*.pem',
  '*.key',
  '*.p8',
  '*.jks',
  '*.keystore',
  '*.mobileprovision',
  'apps/target-ait/.granite/',
  'apps/target-ait/public/game/',
  'apps/target-devvit/dist/',
  'apps/mobile-capacitor/www/',
  'apps/mobile-capacitor/android/.gradle/',
  'apps/mobile-capacitor/android/local.properties',
  'apps/mobile-capacitor/android/**/build/',
  'apps/mobile-capacitor/ios/**/build/',
  'apps/mobile-capacitor/ios/**/xcuserdata/',
  'apps/mobile-capacitor/ios/**/.swiftpm/',
  'native-plugins/*/android/build/',
  'native-plugins/*/ios/.build/',
];

const publishableRoots = ['packages', 'adapters', 'native-plugins', 'backend'];
const allowedGeneratedSourcePrefixes = [
  'packages/cli/templates/phaser-game/src/env.d.ts',
  'packages/i18n/src/paraglide/',
  'packages/i18n/src/paraglideAdapter.',
];
const blockedTrackedGeneratedPrefixes = [
  'artifacts/',
  'release-output/',
  'output/',
  'apps/target-ait/public/assets/',
  'apps/target-ait/public/game/',
  'apps/target-devvit/dist/',
  'apps/mobile-capacitor/www/',
  'apps/game-services-worker/dist/',
];
const binaryFileExtensions = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.jar',
  '.keystore',
  '.mobileprovision',
  '.pdf',
  '.zip',
  '.tgz',
];
const secretPatterns = [
  {
    label: 'private key material',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |)?PRIVATE KEY-----/,
  },
  {
    label: 'npm token',
    pattern: /npm_[A-Za-z0-9]{30,}/,
  },
  {
    label: 'GitHub token',
    pattern: /gh[pousr]_[A-Za-z0-9_]{30,}/,
  },
  {
    label: 'Google API key',
    pattern: /AIza[0-9A-Za-z_-]{30,}/,
  },
  {
    label: 'Cloudflare API token',
    pattern: /[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  },
];
const manualGateMessages = {
  sampleAds:
    'Sample AdMob placement IDs are present; confirm README/docs mark them sample-only or replace them before production release.',
  sampleProducts:
    'Sample product catalog IDs are present; confirm they are intentional starter IDs or replace them with store product IDs.',
  d1Placeholder:
    'Cloudflare Worker D1 database_id is a placeholder; create/bind D1 before production deploy or keep the Worker documented as memory-only starter.',
  mockPaths:
    'Mock/demo-only platform paths are visible; confirm known limitations explain that real store/ad verification is not bundled yet.',
  githubSettings:
    'Confirm GitHub repository settings: branch protection, Actions permissions, issue/discussion settings, and repository topics.',
  deploymentSecrets:
    'Confirm deployment credentials: npm OIDC trusted publishing/provenance, Cloudflare deploy auth, Android signing secrets, iOS signing credentials, and Apps in Toss release credentials. Use NPM_TOKEN only for a non-OIDC fallback.',
  secretScan:
    'Run an external secret scanner such as gitleaks before changing repository visibility.',
} as const;

const failures: string[] = [];
const manualGates: string[] = [];
const targetConfigFilterEnvName = 'MPGD_TARGET_CONFIG_TARGETS';

for (const file of requiredFiles) {
  if (!existsSync(file)) {
    failures.push(`Missing public-readiness file: ${file}`);
  }
}

const gitignore = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';

for (const pattern of requiredIgnorePatterns) {
  if (!gitignore.split(/\r?\n/).includes(pattern)) {
    failures.push(`.gitignore is missing ${pattern}`);
  }
}

validatePackageMetadata('package.json', readPackageJson('package.json'), {
  allowPrivate: true,
  requirePublicAccess: false,
});

for (const workspacePackage of discoverPublishablePackages()) {
  validatePackageMetadata(workspacePackage.packageJsonPath, workspacePackage.packageJson, {
    allowPrivate: false,
    requirePublicAccess: true,
  });
}

for (const root of publishableRoots) {
  collectSourceGeneratedArtifacts(root);
}

collectTrackedGeneratedArtifacts();
collectTrackedGeneratedSourceArtifacts();
collectCatalogReadiness();
collectTargetConfigReadiness();
collectEffectiveTargetConfigReadiness();
collectSecretFindings();
collectManualReleaseGates();

if (failures.length > 0) {
  throw new Error(`Public readiness failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  `Public readiness passed: ${discoverPublishablePackages().length} publishable packages`,
);

if (manualGates.length > 0) {
  console.log(`Manual public release gates:\n- ${manualGates.join('\n- ')}`);
}

function readPackageJson(path: string): PackageMetadata {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageMetadata;
}

function validatePackageMetadata(
  path: string,
  packageJson: PackageMetadata,
  options: {
    readonly allowPrivate: boolean;
    readonly requirePublicAccess: boolean;
  },
): void {
  const label = packageJson.name ?? path;

  if (!options.allowPrivate && packageJson.private === true) {
    failures.push(`${label} should not be private in publishable package discovery.`);
  }

  assertNonEmpty(path, label, 'description', packageJson.description);
  assertNonEmpty(path, label, 'license', packageJson.license);
  assertNonEmpty(path, label, 'repository.type', packageJson.repository?.type);
  assertNonEmpty(path, label, 'repository.url', packageJson.repository?.url);
  assertNonEmpty(path, label, 'bugs.url', packageJson.bugs?.url);
  assertNonEmpty(path, label, 'homepage', packageJson.homepage);

  if (packageJson.keywords === undefined || packageJson.keywords.length === 0) {
    failures.push(`${path}: ${label} must define non-empty keywords.`);
  }

  if (
    options.requirePublicAccess
    && packageJson.publishConfig?.access !== 'public'
  ) {
    failures.push(`${path}: ${label} must set publishConfig.access to public.`);
  }
}

function assertNonEmpty(
  path: string,
  label: string,
  field: string,
  value: string | undefined,
): void {
  if (value === undefined || value.trim().length === 0) {
    failures.push(`${path}: ${label} is missing ${field}.`);
  }
}

function collectSourceGeneratedArtifacts(root: string): void {
  if (!existsSync(root)) {
    return;
  }

  for (const entry of walk(root)) {
    if (!entry.includes('/src/')) {
      continue;
    }

    if (!entry.endsWith('.js') && !entry.endsWith('.d.ts')) {
      continue;
    }

    if (allowedGeneratedSourcePrefixes.some((prefix) => entry.startsWith(prefix))) {
      continue;
    }

    failures.push(`Generated source artifact should not be committed: ${entry}`);
  }
}

function collectTrackedGeneratedArtifacts(): void {
  for (const file of gitLsFiles()) {
    if (blockedTrackedGeneratedPrefixes.some((prefix) => file.startsWith(prefix))) {
      failures.push(`Generated release/build artifact should not be tracked: ${file}`);
    }
  }
}

function collectTrackedGeneratedSourceArtifacts(): void {
  for (const file of gitLsFiles()) {
    if (!file.includes('/src/')) {
      continue;
    }

    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) {
      continue;
    }

    if (allowedGeneratedSourcePrefixes.some((prefix) => file.startsWith(prefix))) {
      continue;
    }

    failures.push(`Generated source artifact should not be tracked: ${file}`);
  }
}

function collectEffectiveTargetConfigReadiness(): void {
  try {
    validateEffectiveTargetConfigMatrix();
  } catch (error) {
    failures.push(`Effective target config release readiness failed: ${errorMessage(error)}`);
  }
}

function collectCatalogReadiness(): void {
  try {
    validateProductCatalogFile();
  } catch (error) {
    failures.push(`Product catalog public readiness failed: ${errorMessage(error)}`);
  }

  try {
    validateAdPlacementsFile();
  } catch (error) {
    failures.push(`Ad placement public readiness failed: ${errorMessage(error)}`);
  }
}

function collectTargetConfigReadiness(): void {
  try {
    withEnvUnset(targetConfigFilterEnvName, () => validateTargetConfigMatrixFile());
  } catch (error) {
    failures.push(`Target config public readiness failed: ${errorMessage(error)}`);
  }
}

function withEnvUnset<T>(name: string, callback: () => T): T {
  const previous = process.env[name];

  delete process.env[name];

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function collectSecretFindings(): void {
  for (const file of gitLsFiles()) {
    if (binaryFileExtensions.some((extension) => file.endsWith(extension))) {
      continue;
    }

    const content = readFileSync(file, 'utf8');

    for (const secret of secretPatterns) {
      if (secret.pattern.test(content)) {
        failures.push(`Potential ${secret.label} committed in ${file}`);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectManualReleaseGates(): void {
  const adPlacements = readFileIfExists('packages/catalog/placements.json');
  const productCatalog = readFileIfExists('packages/catalog/catalog.json');
  const workerConfig = readFileIfExists('apps/game-services-worker/wrangler.toml');
  const aitBridge = readFileIfExists('apps/target-ait/src/aitBridge.ts');
  const i18nMessages = [
    readFileIfExists('packages/i18n/messages/en.json'),
    readFileIfExists('packages/i18n/messages/ko.json'),
  ].join('\n');

  if (/ca-app-pub-xxx|ca-app-pub-yyy/.test(adPlacements)) {
    manualGates.push(manualGateMessages.sampleAds);
  }

  if (/coins_100|remove_ads/.test(productCatalog)) {
    manualGates.push(manualGateMessages.sampleProducts);
  }

  if (workerConfig.includes('<replace-with-wrangler-d1-create-output>')) {
    manualGates.push(manualGateMessages.d1Placeholder);
  }

  if (aitBridge.includes('ait-mock') || i18nMessages.includes('mock only')) {
    manualGates.push(manualGateMessages.mockPaths);
  }

  manualGates.push(manualGateMessages.githubSettings);
  manualGates.push(manualGateMessages.deploymentSecrets);
  manualGates.push(manualGateMessages.secretScan);
}

function readFileIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function gitLsFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter((file) => file.length > 0 && existsSync(file));
}

function walk(root: string): string[] {
  const entries: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const relativePath = relative(process.cwd(), path).split('\\').join('/');
    const stats = statSync(path);

    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') {
        continue;
      }

      entries.push(...walk(path));
      continue;
    }

    entries.push(relativePath);
  }

  return entries;
}
