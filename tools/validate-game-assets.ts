import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';

import { listGameAssets } from '../apps/game-phaser/src/game/assets/manifest';

const publicRoot = 'apps/game-phaser/public';
const publicAssetsRoot = join(publicRoot, 'assets');
const assetBudgetMb = Number.parseFloat(process.env.MPGD_GAME_ASSET_BUDGET_MB ?? '100');
const assetBudgetBytes = Math.floor(assetBudgetMb * 1024 * 1024);

const manifestEntries = listGameAssets();
const manifestPaths = new Set<string>();
const manifestKeys = new Set<string>();
let manifestBytes = 0;

for (const entry of manifestEntries) {
  if (manifestKeys.has(entry.key)) {
    throw new Error(`Duplicate game asset key: ${entry.key}`);
  }

  manifestKeys.add(entry.key);

  if (!entry.path.startsWith('/assets/')) {
    throw new Error(`Game asset ${entry.key} must use an /assets/ public path.`);
  }

  const filePath = publicPathToFile(entry.path);

  if (!existsSync(filePath)) {
    throw new Error(`Missing game asset ${entry.key}: ${entry.path} (${filePath})`);
  }

  const stat = statSync(filePath);

  if (!stat.isFile()) {
    throw new Error(`Game asset ${entry.key} is not a file: ${entry.path}`);
  }

  manifestPaths.add(entry.path);
  manifestBytes += stat.size;
}

const publicAssetPaths = existsSync(publicAssetsRoot)
  ? walkFiles(publicAssetsRoot).map((path) => fileToPublicAssetPath(path)).sort()
  : [];

for (const path of publicAssetPaths) {
  if (!manifestPaths.has(path)) {
    throw new Error(`Public asset is not registered in game asset manifest: ${path}`);
  }
}

if (manifestBytes > assetBudgetBytes) {
  throw new Error(
    `Game manifest assets exceed budget: ${formatBytes(manifestBytes)} > ${formatBytes(
      assetBudgetBytes,
    )}`,
  );
}

console.log(
  `Game assets ${manifestEntries.length} entries, ${formatBytes(
    manifestBytes,
  )} registered, ${publicAssetPaths.length} public files, budget ${formatBytes(
    assetBudgetBytes,
  )}`,
);

function publicPathToFile(path: string): string {
  const normalized = normalize(path).replace(/^\/+/, '');

  if (normalized.startsWith('..') || normalized.includes(`${sep}..${sep}`)) {
    throw new Error(`Invalid game asset public path: ${path}`);
  }

  return join(publicRoot, normalized);
}

function fileToPublicAssetPath(path: string): string {
  return `/${relative(publicRoot, path).split(sep).join('/')}`;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      files.push(...walkFiles(path));
      continue;
    }

    if (stat.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
