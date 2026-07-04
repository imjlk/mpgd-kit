import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { discoverBuildablePackages, sortByWorkspaceDependencies } from './workspace';

const cacheDir = join('node_modules', '.cache', 'mpgd-package-build');
const packages = discoverBuildablePackages();
const packagePaths = Object.fromEntries(
  packages.map((workspacePackage) => [
    workspacePackage.name,
    [toPosix(relative(cacheDir, join(workspacePackage.dir, 'dist')))],
  ]),
);
const allowedGeneratedSourcePrefixes = [
  'packages/i18n/src/paraglide/',
  'packages/i18n/src/paraglideAdapter.',
] as const;

mkdirSync(cacheDir, { recursive: true });

for (const workspacePackage of sortByWorkspaceDependencies(packages)) {
  const srcDir = join(workspacePackage.dir, 'src');
  const tsconfigPath = join(workspacePackage.dir, 'tsconfig.json');
  const distDir = join(workspacePackage.dir, 'dist');

  if (!existsSync(srcDir) || !existsSync(tsconfigPath)) {
    throw new Error(`Package is missing src or tsconfig.json: ${workspacePackage.name}`);
  }

  rmSync(distDir, { force: true, recursive: true });

  const tempConfigPath = join(cacheDir, `${safeFileName(workspacePackage.name)}.json`);
  const tempConfigDir = dirname(tempConfigPath);
  writeFileSync(
    tempConfigPath,
    JSON.stringify(
      {
        extends: toPosix(relative(tempConfigDir, tsconfigPath)),
        compilerOptions: {
          noEmit: false,
          outDir: toPosix(relative(tempConfigDir, distDir)),
          rootDir: toPosix(relative(tempConfigDir, srcDir)),
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: false,
          sourceMap: false,
          paths: packagePaths,
        },
        include: [toPosix(relative(tempConfigDir, join(srcDir, '**/*.ts')))],
        exclude: [
          toPosix(relative(tempConfigDir, join(srcDir, '**/*.test.ts'))),
          toPosix(relative(tempConfigDir, join(srcDir, '**/*.spec.ts'))),
        ],
      },
      null,
      2,
    ),
  );

  run('pnpm', ['exec', 'ttsc', '-p', tempConfigPath]);
  run('pnpm', ['exec', 'tsc', '-p', tempConfigPath, '--emitDeclarationOnly']);
  copySourceRuntimeAssets(srcDir, distDir);
  copyRuntimeAssets(srcDir, distDir);
  formatDeclarationFiles(distDir);
  removeGeneratedSourceSiblings(srcDir);

  assertFile(join(distDir, 'index.js'));
  assertFile(join(distDir, 'index.d.ts'));
  console.log(`Built ${workspacePackage.name}`);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function assertFile(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing package build artifact: ${path}`);
  }
}

function formatDeclarationFiles(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      formatDeclarationFiles(path);
      continue;
    }

    if (!path.endsWith('.d.ts')) {
      continue;
    }

    const source = readFileSync(path, 'utf8');
    const formatted = `${source
      .replace(/^( +)/gm, (indent) => ' '.repeat(Math.floor(indent.length / 2)))
      .trimEnd()}\n`;

    writeFileSync(path, formatted);
  }
}

function copySourceRuntimeAssets(srcDir: string, distDir: string): void {
  forEachSourceBackedArtifact(srcDir, false, (sourcePath, sourceSibling) => {
    if (existsSync(sourceSibling)) {
      return;
    }

    copyFileSync(sourcePath, join(distDir, basename(sourcePath)));
  });
}

function copyRuntimeAssets(srcDir: string, distDir: string): void {
  const generatedDir = join(srcDir, 'paraglide');

  if (!existsSync(generatedDir)) {
    return;
  }

  copyDir(generatedDir, join(distDir, 'paraglide'));
}

function removeGeneratedSourceSiblings(dir: string): void {
  forEachSourceBackedArtifact(dir, true, (path, sourceSibling) => {
    if (!isAllowedGeneratedSource(path) && existsSync(sourceSibling)) {
      rmSync(path);
    }
  });
}

function forEachSourceBackedArtifact(
  dir: string,
  recursive: boolean,
  callback: (artifactPath: string, sourceSibling: string) => void,
): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      if (recursive) {
        forEachSourceBackedArtifact(path, recursive, callback);
      }
      continue;
    }

    if (!path.endsWith('.js') && !path.endsWith('.d.ts')) {
      continue;
    }

    const sourceSibling = path.endsWith('.d.ts')
      ? `${path.slice(0, -5)}.ts`
      : `${path.slice(0, -3)}.ts`;

    callback(path, sourceSibling);
  }
}

function isAllowedGeneratedSource(path: string): boolean {
  const normalizedPath = toPosix(path);

  return allowedGeneratedSourcePrefixes.some((prefix) => normalizedPath.startsWith(prefix));
}

function copyDir(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir)) {
    if (entry === '.gitignore' || entry === '.prettierignore') {
      continue;
    }

    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);

    if (statSync(sourcePath).isDirectory()) {
      copyDir(sourcePath, targetPath);
      continue;
    }

    copyFileSync(sourcePath, targetPath);
  }
}

function safeFileName(value: string): string {
  return value.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}
