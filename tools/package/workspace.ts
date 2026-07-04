import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageJson {
  readonly name?: string;
  readonly private?: boolean;
  readonly version?: string;
  readonly exports?: unknown;
  readonly files?: readonly string[];
  readonly main?: string;
  readonly types?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  readonly dir: string;
  readonly packageJsonPath: string;
  readonly packageJson: PackageJson;
  readonly name: string;
}

const packageRoots = ['packages', 'adapters', 'native-plugins', 'backend'];

export function discoverBuildablePackages(): WorkspacePackage[] {
  return packageRoots
    .flatMap((root) => discoverPackagesInRoot(root))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverPublishablePackages(): WorkspacePackage[] {
  return packageRoots
    .flatMap((root) => discoverPackagesInRoot(root))
    .filter((workspacePackage) => workspacePackage.packageJson.private !== true)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function sortByWorkspaceDependencies(
  packages: readonly WorkspacePackage[],
): WorkspacePackage[] {
  const byName = new Map(
    packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const sorted: WorkspacePackage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const workspacePackage of packages) {
    visit(workspacePackage);
  }

  return sorted;

  function visit(workspacePackage: WorkspacePackage): void {
    if (visited.has(workspacePackage.name)) {
      return;
    }

    if (visiting.has(workspacePackage.name)) {
      throw new Error(`Circular workspace package dependency: ${workspacePackage.name}`);
    }

    visiting.add(workspacePackage.name);

    for (const dependencyName of internalDependencyNames(workspacePackage.packageJson)) {
      const dependency = byName.get(dependencyName);

      if (dependency !== undefined) {
        visit(dependency);
      }
    }

    visiting.delete(workspacePackage.name);
    visited.add(workspacePackage.name);
    sorted.push(workspacePackage);
  }
}

function internalDependencyNames(packageJson: PackageJson): string[] {
  return Object.entries(packageJson.dependencies ?? {})
    .filter(([, version]) => version.startsWith('workspace:'))
    .map(([name]) => name);
}

function discoverPackagesInRoot(root: string): WorkspacePackage[] {
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((dir) => statSync(dir).isDirectory())
    .map((dir) => readWorkspacePackage(dir));
}

function readWorkspacePackage(dir: string): WorkspacePackage {
  const packageJsonPath = join(dir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;

  if (packageJson.name === undefined || packageJson.name.length === 0) {
    throw new Error(`Missing package name: ${packageJsonPath}`);
  }

  return {
    dir,
    packageJsonPath,
    packageJson,
    name: packageJson.name,
  };
}
