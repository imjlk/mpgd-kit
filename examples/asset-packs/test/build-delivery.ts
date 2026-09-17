import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAssetPacks } from '../../../packages/cli/src/asset-pack-build';

/** Anchor to this module so the script runs from any working directory. */
const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Build the delivery variants the browser acceptance consumes: an all-ZIP
 * output and a mixed files+ZIP output, produced by the real `build-packs`
 * code path into the static origin directory the tests serve. Re-running is
 * a no-op: pack artifacts are immutable and the manifest is replaceable. */
for (const variant of ['zip', 'mixed'] as const) {
  const report = buildAssetPacks({
    configPath: `delivery-configs/${variant}.json`,
    outDir: 'artifacts/origin/delivery/' + variant,
    cwd: exampleRoot,
  });
  for (const archive of report.archives) {
    console.info(
      `delivery/${variant} archive ${archive.packId}: ${archive.entryCount} entries `
      + `(${archive.storeEntries} store, ${archive.deflateEntries} deflate), `
      + `sources ${archive.sourceBytes} bytes, archive ${archive.archiveBytes} bytes`,
    );
  }
  console.info(`delivery/${variant} manifest: ${report.manifestPath}`);
}
