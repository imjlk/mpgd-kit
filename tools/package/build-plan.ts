import { workspaceDependencyNames } from './build-fingerprint';
import type { WorkspacePackage } from './workspace';

export function selectBuildablePackages(
  available: readonly WorkspacePackage[],
  requestedNames: readonly string[],
): WorkspacePackage[] {
  const byName = new Map(available.map((item) => [item.name, item]));
  const selected = new Set<string>();
  function select(name: string): void {
    if (selected.has(name)) {
      return;
    }
    const item = byName.get(name);
    if (item === undefined) {
      throw new Error(`Unknown buildable workspace package: ${name}`);
    }
    selected.add(name);
    for (const dependency of workspaceDependencyNames(item)) {
      if (byName.has(dependency)) {
        select(dependency);
      }
    }
  }
  for (const name of requestedNames) {
    select(name);
  }
  return available.filter((item) => selected.has(item.name));
}

// Each dist has exactly one owner. Dependencies may compile in both isolated
// runners, but only their owner's output is transferred to consumers.
export function planPackageShard(available: readonly WorkspacePackage[], shard: string) {
  if (shard !== 'starter' && shard !== 'remaining') {
    throw new Error(`Unknown package shard: ${shard}`);
  }
  const starter = selectBuildablePackages(available, ['@mpgd/create-game']);
  const starterNames = new Set(starter.map((item) => item.name));
  const owned = available.filter((item) => starterNames.has(item.name) === (shard === 'starter'));
  const packages = selectBuildablePackages(
    available,
    owned.map((item) => item.name),
  );
  const distPath = (item: WorkspacePackage) => `${item.dir.replaceAll('\\', '/')}/dist`;
  return {
    packages,
    manifest: { shard, owned: owned.map(distPath), inventory: available.map(distPath) },
  };
}
