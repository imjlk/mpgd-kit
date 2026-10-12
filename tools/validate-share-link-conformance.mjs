import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// An adapter that implements `ShareAdapter.share` hands share links to a host,
// so its tests must run `runShareLinkConformance` from
// `@mpgd/platform/share-link-conformance` over the shared route vectors. This
// finds adapters whose sources define a `share` method or property and whose
// tests never run it, so a new adapter cannot skip the check.

// `share(`, `async share(`, and `share:`, but not `options.share`, `share?:`,
// or `shareAppMessage(`.
const sharePattern = /(?:^|[^\w$.])(?:async\s+)?share\s*[(:]/mu;
const runnerPattern = /\brunShareLinkConformance\s*\(/u;
const skippedDirectories = new Set(['node_modules', 'dist']);

/**
 * Adapters whose share hands its host no link, each with the reason. One that
 * starts handing its host a link leaves this list and runs the conformance.
 */
export const shareLinkConformanceExemptions = new Map([
  [
    'wechat',
    'wx.shareAppMessage takes a title, query, and image, never a link, and mini-game '
      + 'runtimes have no URL global for the route rule, so the adapter drops deepLink',
  ],
]);

/**
 * Lists the adapters under `adaptersRoot` that define a share and run no share
 * link conformance, each with the source files that define one. Adapters in
 * `exemptions` are skipped.
 */
export function findShareLinkConformanceGaps(
  adaptersRoot,
  exemptions = shareLinkConformanceExemptions,
) {
  const gaps = [];

  for (const entry of readdirSync(adaptersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || exemptions.has(entry.name)) {
      continue;
    }

    const adapterRoot = join(adaptersRoot, entry.name);
    const files = listTypeScriptFiles(adapterRoot);
    const sharingFiles = files.filter(
      (file) => !isTestFile(adapterRoot, file) && sharePattern.test(readFileSync(file, 'utf8')),
    );

    if (sharingFiles.length === 0) {
      continue;
    }

    const runsConformance = files.some(
      (file) => isTestFile(adapterRoot, file) && runnerPattern.test(readFileSync(file, 'utf8')),
    );

    if (!runsConformance) {
      gaps.push({
        adapter: entry.name,
        files: sharingFiles.map((file) => relative(adapterRoot, file).split(sep).join('/')),
      });
    }
  }

  return gaps;
}

function listTypeScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...listTypeScriptFiles(path));
      }
    } else if (/\.(?:m|c)?ts$/u.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }

  return files;
}

function isTestFile(adapterRoot, file) {
  const path = relative(adapterRoot, file).split(sep).join('/');

  return /\.test\.(?:m|c)?ts$/u.test(path) || path.startsWith('test/');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const adaptersRoot = fileURLToPath(new URL('../adapters', import.meta.url));
  const gaps = findShareLinkConformanceGaps(adaptersRoot);

  if (gaps.length > 0) {
    for (const gap of gaps) {
      console.error(
        `adapters/${gap.adapter}: ${gap.files.join(', ')} define a share, but no test runs `
          + 'runShareLinkConformance from @mpgd/platform/share-link-conformance.',
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      'Every adapter that defines a share runs the share link conformance (exempt: '
        + `${[...shareLinkConformanceExemptions.keys()].join(', ')}).`,
    );
  }
}
