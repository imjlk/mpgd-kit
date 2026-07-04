import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverPublishablePackages } from './package/workspace';

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
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p8',
  '*.jks',
  '*.keystore',
  '*.mobileprovision',
];

const publishableRoots = ['packages', 'adapters', 'native-plugins', 'backend'];
const allowedGeneratedSourcePrefixes = [
  'packages/i18n/src/paraglide/',
  'packages/i18n/src/paraglideAdapter.',
];

const failures: string[] = [];

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

if (failures.length > 0) {
  throw new Error(`Public readiness failed:\n- ${failures.join('\n- ')}`);
}

console.log(
  `Public readiness passed: ${discoverPublishablePackages().length} publishable packages`,
);

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
