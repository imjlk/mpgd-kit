import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverPublishablePackages, type PackageJson } from './workspace';

interface NpmPackFile {
  readonly path: string;
}

interface NpmPackResult {
  readonly filename: string;
  readonly files: readonly NpmPackFile[];
}

for (const workspacePackage of discoverPublishablePackages()) {
  validatePackageMetadata(workspacePackage.name, workspacePackage.packageJson);

  const distIndex = join(workspacePackage.dir, 'dist/index.js');
  const distTypes = join(workspacePackage.dir, 'dist/index.d.ts');

  assertFile(distIndex);
  assertFile(distTypes);

  const pack = npmPackDryRun(workspacePackage.dir);
  const packedFiles = new Set(pack.files.map((file) => stripPackagePrefix(file.path)));
  const expectedFiles = [
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    ...expectedBinFiles(workspacePackage.packageJson),
    ...expectedTemplateFiles(workspacePackage.dir, workspacePackage.packageJson),
    ...expectedExportFiles(workspacePackage.packageJson),
  ];

  for (const expectedFile of expectedFiles) {
    if (!packedFiles.has(expectedFile)) {
      throw new Error(`${workspacePackage.name} tarball is missing ${expectedFile}`);
    }
  }

  console.log(`Pack smoke passed ${workspacePackage.name}: ${pack.filename}`);
}

function validatePackageMetadata(name: string, packageJson: PackageJson): void {
  if (packageJson.main !== './dist/index.js') {
    throw new Error(`${name} must set main to ./dist/index.js`);
  }

  if (packageJson.types !== './dist/index.d.ts') {
    throw new Error(`${name} must set types to ./dist/index.d.ts`);
  }

  if (packageJson.files?.includes('dist') !== true) {
    throw new Error(`${name} must include dist in package files`);
  }

  const rootExport = readRootExport(packageJson);

  if (rootExport.types !== './dist/index.d.ts') {
    throw new Error(`${name} export "." must expose ./dist/index.d.ts`);
  }

  if (rootExport.default !== './dist/index.js') {
    throw new Error(`${name} export "." must expose ./dist/index.js`);
  }
}

function readRootExport(packageJson: PackageJson): { readonly types?: string; readonly default?: string } {
  if (typeof packageJson.exports !== 'object' || packageJson.exports === null) {
    throw new Error(`${packageJson.name ?? 'package'} must define exports`);
  }

  const exportsMap = packageJson.exports as Record<string, unknown>;
  const rootExport = exportsMap['.'];

  if (typeof rootExport !== 'object' || rootExport === null) {
    throw new Error(`${packageJson.name ?? 'package'} must define exports["."]`);
  }

  return rootExport as { readonly types?: string; readonly default?: string };
}

function expectedExportFiles(packageJson: PackageJson): string[] {
  if (typeof packageJson.exports !== 'object' || packageJson.exports === null) {
    return [];
  }

  const exportsMap = packageJson.exports as Record<string, unknown>;

  return [...new Set(Object.values(exportsMap).flatMap(readExportPaths))];
}

function expectedBinFiles(packageJson: PackageJson): string[] {
  if (typeof packageJson.bin === 'string') {
    return [packageJson.bin.replace(/^\.\//, '')];
  }

  if (typeof packageJson.bin !== 'object' || packageJson.bin === null) {
    return [];
  }

  return Object.values(packageJson.bin).map((value) => value.replace(/^\.\//, ''));
}

function expectedTemplateFiles(packageDir: string, packageJson: PackageJson): string[] {
  if (packageJson.files?.includes('templates') !== true) {
    return [];
  }

  const templatesDir = join(packageDir, 'templates');

  if (!existsSync(templatesDir)) {
    return [];
  }

  return readdirSync(templatesDir)
    .map((entry) => join(templatesDir, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .map((templateDir) => {
      const packageJsonPath = join(templateDir, 'package.json');

      if (!existsSync(packageJsonPath)) {
        throw new Error(
          `${packageJson.name ?? 'package'} template ${relative(packageDir, templateDir)} must include package.json`,
        );
      }

      return relative(packageDir, packageJsonPath).split('\\').join('/');
    });
}

function readExportPaths(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value.replace(/^\.\//, '')];
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.values(value as Record<string, unknown>).flatMap(readExportPaths);
}

function npmPackDryRun(cwd: string): NpmPackResult {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd,
    env: process.env,
    encoding: 'utf8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`npm pack failed in ${cwd}:\n${result.stderr}`);
  }

  const output = JSON.parse(result.stdout) as readonly NpmPackResult[];
  const [pack] = output;

  if (pack === undefined) {
    throw new Error(`npm pack returned no result in ${cwd}`);
  }

  return pack;
}

function assertFile(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing package artifact: ${path}`);
  }
}

function stripPackagePrefix(path: string): string {
  return path.replace(/^package\//, '');
}
